import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as s3 from "../../../apps/api/src/storage/s3";

const mockLimit = vi.fn().mockReturnValue(Promise.resolve([]));
const mockReturning = vi.fn().mockReturnValue(Promise.resolve([]));

const selectQuery = {
  from: vi.fn().mockReturnThis(),
  innerJoin: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: mockLimit,
};

const insertQuery = {
  values: vi.fn().mockReturnThis(),
  returning: mockReturning,
};

vi.mock("../../../apps/api/src/database", () => {
  return {
    default: {
      select: vi.fn(() => selectQuery),
      insert: vi.fn(() => insertQuery),
    },
  };
});

describe("uploadTaskAttachment controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("successfully uploads attachment and returns structured result", async () => {
    const uploadTaskAttachment = (
      await import("../../../apps/api/src/task/controllers/upload-task-attachment")
    ).default;

    const mockTask = {
      taskId: "task-cuid-123",
      projectId: "proj-123",
      workspaceId: "ws-123",
    };

    mockLimit.mockImplementation(() => Promise.resolve([mockTask]));
    mockReturning.mockResolvedValueOnce([{ id: "asset-cuid-456" }]);

    vi.spyOn(s3, "uploadTaskAssetDirect").mockResolvedValueOnce({
      key: "workspace/ws-123/project/proj-123/task/task-cuid-123/descriptions/screenshot.png",
    });

    const buffer = Buffer.from("image-bytes");
    const result = await uploadTaskAttachment({
      taskIdOrTicket: "task-cuid-123",
      file: {
        filename: "screenshot.png",
        contentType: "image/png",
        size: buffer.length,
        buffer,
      },
      surface: "description",
      userId: "user-1",
      apiBaseUrl: "https://kaneo.getiwas.com/api",
    });

    expect(result).toEqual({
      id: "asset-cuid-456",
      url: "https://kaneo.getiwas.com/api/asset/asset-cuid-456",
      filename: "screenshot.png",
      contentType: "image/png",
      size: buffer.length,
      markdown:
        "![screenshot.png](https://kaneo.getiwas.com/api/asset/asset-cuid-456)",
    });
  });

  it("handles ticket ID lookup and non-image markdown link", async () => {
    const uploadTaskAttachment = (
      await import("../../../apps/api/src/task/controllers/upload-task-attachment")
    ).default;

    const mockTask = {
      taskId: "task-cuid-123",
      projectId: "proj-123",
      workspaceId: "ws-123",
    };

    mockLimit.mockImplementation(() => Promise.resolve([mockTask]));
    mockReturning.mockResolvedValueOnce([{ id: "asset-pdf-789" }]);

    vi.spyOn(s3, "uploadTaskAssetDirect").mockResolvedValueOnce({
      key: "workspace/ws-123/project/proj-123/task/task-cuid-123/descriptions/report.pdf",
    });

    const buffer = Buffer.from("pdf-bytes");
    const result = await uploadTaskAttachment({
      taskIdOrTicket: "IWAS-25",
      file: {
        filename: "report.pdf",
        contentType: "application/pdf",
        size: buffer.length,
        buffer,
      },
      surface: "comment",
      userId: "user-1",
      apiBaseUrl: "https://kaneo.getiwas.com/api",
    });

    expect(result).toEqual({
      id: "asset-pdf-789",
      url: "https://kaneo.getiwas.com/api/asset/asset-pdf-789",
      filename: "report.pdf",
      contentType: "application/pdf",
      size: buffer.length,
      markdown:
        "[report.pdf](https://kaneo.getiwas.com/api/asset/asset-pdf-789)",
    });
  });

  it("throws 404 when task cannot be found", async () => {
    const uploadTaskAttachment = (
      await import("../../../apps/api/src/task/controllers/upload-task-attachment")
    ).default;

    mockLimit.mockImplementation(() => Promise.resolve([]));

    const buffer = Buffer.from("bytes");
    await expect(
      uploadTaskAttachment({
        taskIdOrTicket: "NOTFOUND-99",
        file: {
          filename: "test.txt",
          contentType: "text/plain",
          size: buffer.length,
          buffer,
        },
        apiBaseUrl: "https://kaneo.getiwas.com/api",
      }),
    ).rejects.toThrow("Task not found");
  });
});
