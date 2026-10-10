import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  assetTable,
  projectTable,
  taskTable,
  workspaceTable,
} from "../../database/schema";
import {
  isImageContentType,
  uploadTaskAssetDirect,
  validateTaskAssetUploadInput,
} from "../../storage/s3";
import { TICKET_ID_PATTERN } from "../ticket-id";

export type UploadTaskAttachmentParams = {
  taskIdOrTicket: string;
  file: {
    filename: string;
    contentType: string;
    size: number;
    buffer: Buffer | Uint8Array;
  };
  surface?: "description" | "comment";
  userId?: string | null;
  apiBaseUrl: string;
};

export default async function uploadTaskAttachment({
  taskIdOrTicket,
  file,
  surface = "description",
  userId,
  apiBaseUrl,
}: UploadTaskAttachmentParams) {
  const { filename, contentType, size, buffer } = file;

  try {
    validateTaskAssetUploadInput(contentType, size);
  } catch (error) {
    throw new HTTPException(400, {
      message:
        error instanceof Error
          ? error.message
          : "Invalid attachment upload request",
    });
  }

  const match = taskIdOrTicket.normalize("NFKC").match(TICKET_ID_PATTERN);
  const condition = match
    ? and(
        eq(taskTable.number, Number(match[2])),
        sql`lower(${projectTable.slug}) = lower(${match[1]})`,
      )
    : eq(taskTable.id, taskIdOrTicket);

  const [task] = await db
    .select({
      taskId: taskTable.id,
      projectId: taskTable.projectId,
      workspaceId: workspaceTable.id,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .innerJoin(workspaceTable, eq(projectTable.workspaceId, workspaceTable.id))
    .where(condition)
    .limit(1);

  if (!task) {
    throw new HTTPException(404, { message: "Task not found" });
  }

  let uploadResult: { key: string };
  try {
    uploadResult = await uploadTaskAssetDirect(
      {
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        taskId: task.taskId,
        surface,
        filename,
        contentType,
        size,
      },
      buffer,
    );
  } catch (error) {
    throw new HTTPException(503, {
      message:
        error instanceof Error
          ? error.message
          : "Failed to upload attachment to storage",
    });
  }

  const [saved] = await db
    .insert(assetTable)
    .values({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.taskId,
      objectKey: uploadResult.key,
      filename,
      mimeType: contentType,
      size,
      kind: isImageContentType(contentType) ? "image" : "attachment",
      surface,
      createdBy: userId || null,
    })
    .returning({
      id: assetTable.id,
    });

  if (!saved) {
    throw new HTTPException(500, { message: "Failed to record asset" });
  }

  const url = `${apiBaseUrl}/asset/${saved.id}`;
  const isImage = isImageContentType(contentType);
  const markdown = isImage ? `![${filename}](${url})` : `[${filename}](${url})`;

  return {
    id: saved.id,
    url,
    filename,
    contentType,
    size,
    markdown,
  };
}
