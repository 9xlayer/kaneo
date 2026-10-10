import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  uploadTaskAttachment,
  inferMimeType,
} from "./upload-task-attachment.js";
import type { ToolClient } from "./register.js";

describe("uploadTaskAttachment", () => {
  let mockClient: ToolClient;
  let testFilePath: string;

  beforeEach(async () => {
    testFilePath = path.join(tmpdir(), `test-attachment-${Date.now()}.png`);
    await writeFile(testFilePath, Buffer.from("fake-png-content"));

    mockClient = {
      json: vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/api/task/by-ticket-id/")) {
          return { id: "resolved-cuid-123" };
        }
        if (url.includes("/image-upload/") && init?.method === "PUT") {
          return {
            key: "workspace/project/task/test.png",
            uploadUrl: "https://r2.example.com/presigned-put",
            headers: { "Content-Type": "image/png" },
          };
        }
        if (url.includes("/finalize") && init?.method === "POST") {
          return {
            id: "asset-cuid-999",
            url: "https://kaneo.example.com/api/asset/asset-cuid-999",
          };
        }
        throw new Error(`Unexpected url: ${url}`);
      }),
    };

    // Mock global fetch for S3 upload
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://r2.example.com/presigned-put") {
          return new Response("", { status: 200, statusText: "OK" });
        }
        if (url === "https://remote.example.com/avatar.jpg") {
          return new Response(Buffer.from("remote-jpg-content"), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "image/jpeg" },
          });
        }
        return new Response("Not Found", { status: 404 });
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    try {
      await unlink(testFilePath);
    } catch {}
  });

  it("infers mime types correctly", () => {
    expect(inferMimeType("photo.png")).toBe("image/png");
    expect(inferMimeType("doc.pdf")).toBe("application/pdf");
    expect(inferMimeType("notes.txt")).toBe("text/plain");
    expect(inferMimeType("unknown.xyz")).toBe("application/octet-stream");
  });

  it("uploads local file using filePath and ticket ID", async () => {
    const result = await uploadTaskAttachment(mockClient, {
      taskId: "KAN-1",
      filePath: testFilePath,
    });

    expect(result.id).toBe("asset-cuid-999");
    expect(result.url).toBe(
      "https://kaneo.example.com/api/asset/asset-cuid-999",
    );
    expect(result.markdown).toContain("![");
    expect(result.markdown).toContain(
      "](https://kaneo.example.com/api/asset/asset-cuid-999)",
    );

    // Verify resolveTaskId was called
    expect(mockClient.json).toHaveBeenCalledWith(
      "/api/task/by-ticket-id/KAN-1",
      { method: "GET" },
    );

    // Verify upload-url request
    expect(mockClient.json).toHaveBeenCalledWith(
      "/api/task/image-upload/resolved-cuid-123",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining("image/png"),
      }),
    );

    // Verify finalize
    expect(mockClient.json).toHaveBeenCalledWith(
      "/api/task/image-upload/resolved-cuid-123/finalize",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("workspace/project/task/test.png"),
      }),
    );
  });

  it("uploads file from base64", async () => {
    const base64Data = Buffer.from("base64-file-content").toString("base64");
    const result = await uploadTaskAttachment(mockClient, {
      taskId: "direct-task-cuid",
      fileBase64: base64Data,
      filename: "document.pdf",
    });

    expect(result.id).toBe("asset-cuid-999");
    expect(result.contentType).toBe("application/pdf");
    expect(result.markdown).toBe(
      "[document.pdf](https://kaneo.example.com/api/asset/asset-cuid-999)",
    );
  });

  it("uploads file from remote fileUrl", async () => {
    const result = await uploadTaskAttachment(mockClient, {
      taskId: "direct-task-cuid",
      fileUrl: "https://remote.example.com/avatar.jpg",
    });

    expect(result.id).toBe("asset-cuid-999");
    expect(result.filename).toBe("avatar.jpg");
    expect(result.contentType).toBe("image/jpeg");
  });

  it("throws when no file source is provided", async () => {
    await expect(
      uploadTaskAttachment(mockClient, {
        taskId: "task-1",
      }),
    ).rejects.toThrow(
      "Either filePath, fileUrl, or fileBase64 must be provided.",
    );
  });
});
