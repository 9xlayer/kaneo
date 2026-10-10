import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ToolClient } from "./register.js";

const EXTENSION_MIME_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  zip: "application/zip",
  csv: "text/csv",
};

export function inferMimeType(filename: string): string {
  const ext = path.extname(filename).replace(/^\./, "").toLowerCase();
  return EXTENSION_MIME_MAP[ext] || "application/octet-stream";
}

export type UploadTaskAttachmentArgs = {
  taskId: string;
  filePath?: string;
  fileUrl?: string;
  fileBase64?: string;
  filename?: string;
  contentType?: string;
  surface?: "description" | "comment";
};

export type UploadTaskAttachmentResult = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  markdown: string;
};

async function resolveTaskId(
  client: ToolClient,
  taskIdOrTicket: string,
): Promise<string> {
  const trimmed = taskIdOrTicket.trim();
  if (/^[A-Za-z0-9]+-\d+$/.test(trimmed)) {
    try {
      const task = (await client.json(
        `/api/task/by-ticket-id/${encodeURIComponent(trimmed)}`,
        { method: "GET" },
      )) as { id?: string };
      if (task?.id) {
        return task.id;
      }
    } catch {
      // Fallback to passing the original identifier
    }
  }
  return trimmed;
}

export async function uploadTaskAttachment(
  client: ToolClient,
  args: UploadTaskAttachmentArgs,
): Promise<UploadTaskAttachmentResult> {
  let fileData: Uint8Array;
  let filename = args.filename?.trim() || "";
  let contentType = args.contentType?.trim() || "";

  if (args.filePath) {
    const resolvedPath = path.resolve(args.filePath);
    fileData = await readFile(resolvedPath);
    if (!filename) {
      filename = path.basename(resolvedPath);
    }
  } else if (args.fileBase64) {
    fileData = Buffer.from(args.fileBase64, "base64");
    if (!filename) {
      filename = "attachment.bin";
    }
  } else if (args.fileUrl) {
    const res = await fetch(args.fileUrl);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch file from fileUrl: ${res.status} ${res.statusText}`,
      );
    }
    fileData = new Uint8Array(await res.arrayBuffer());
    if (!filename) {
      try {
        const urlObj = new URL(args.fileUrl);
        const nameFromUrl = path.basename(urlObj.pathname);
        if (nameFromUrl && nameFromUrl !== "/") {
          filename = nameFromUrl;
        }
      } catch {
        // Fallback default
      }
      if (!filename) {
        filename = "attachment.bin";
      }
    }
    if (!contentType) {
      const remoteType = res.headers.get("content-type");
      if (remoteType) {
        contentType = remoteType.split(";")[0]?.trim() || "";
      }
    }
  } else {
    throw new Error(
      "Either filePath, fileUrl, or fileBase64 must be provided.",
    );
  }

  if (!contentType) {
    contentType = inferMimeType(filename);
  }

  const resolvedTaskId = await resolveTaskId(client, args.taskId);
  const surface = args.surface || "description";
  const size = fileData.byteLength;

  // 1. Request presigned upload URL from Kaneo API
  const uploadInfo = (await client.json(
    `/api/task/image-upload/${encodeURIComponent(resolvedTaskId)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        filename,
        contentType,
        size,
        surface,
      }),
    },
  )) as {
    key: string;
    uploadUrl: string;
    headers?: Record<string, string>;
  };

  // 2. Upload file bytes to the storage presigned URL
  const uploadHeaders: Record<string, string> = {
    "Content-Type": contentType,
    ...uploadInfo.headers,
  };

  const uploadRes = await fetch(uploadInfo.uploadUrl, {
    method: "PUT",
    headers: uploadHeaders,
    body: fileData as unknown as BodyInit,
  });

  if (!uploadRes.ok) {
    throw new Error(
      `Failed to upload file to storage: ${uploadRes.status} ${uploadRes.statusText}`,
    );
  }

  // 3. Finalize upload with Kaneo API
  const finalized = (await client.json(
    `/api/task/image-upload/${encodeURIComponent(resolvedTaskId)}/finalize`,
    {
      method: "POST",
      body: JSON.stringify({
        key: uploadInfo.key,
        filename,
        contentType,
        size,
        surface,
      }),
    },
  )) as {
    id: string;
    url: string;
  };

  const isImage = contentType.startsWith("image/");
  const markdown = isImage
    ? `![${filename}](${finalized.url})`
    : `[${filename}](${finalized.url})`;

  return {
    id: finalized.id,
    filename,
    contentType,
    size,
    url: finalized.url,
    markdown,
  };
}
