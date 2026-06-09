import { beforeEach, describe, expect, it, vi } from "vitest";

const execSync = vi.fn();
const updateTaskState = vi.fn(async () => undefined);
const uploadFile = vi.fn(async () => undefined);
const statObject = vi.fn(async () => ({ size: 100 }));

vi.mock("node:child_process", () => ({ execSync }));
vi.mock("node:fs", () => ({
  mkdtempSync: vi.fn(() => "/tmp/va-git-x"),
  rmSync: vi.fn(),
  createReadStream: vi.fn(() => ({})),
  existsSync: vi.fn(() => true),
  readdirSync: vi.fn(() => ["file.js"]),
  statSync: vi.fn(() => ({ size: 100 })),
}));
vi.mock("../../src/infra/minio/client.js", () => ({
  uploadFile,
  getMinio: () => ({ statObject }),
}));
vi.mock("../../src/features/tasks/storage.js", () => ({ updateTaskState }));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { cloneAndUpload } = await import("../../src/features/files/git-clone.js");

describe("cloneAndUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statObject.mockResolvedValue({ size: 100 });
  });

  it("clones once and uploads on success (no retry)", async () => {
    execSync.mockReturnValue(Buffer.from(""));
    await cloneAndUpload("t1", "https://x/repo.git", "main", "bucket");
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(updateTaskState).not.toHaveBeenCalled();
  });

  it("retries up to 3 times then fails with user-readable reason", async () => {
    execSync.mockImplementation(() => { throw new Error("ETIMEDOUT"); });
    vi.useFakeTimers();
    const p = cloneAndUpload("t1", "https://x/repo.git", "main", "bucket");
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();
    const cloneCalls = execSync.mock.calls.filter((c) => String(c[0]).includes("git clone")).length;
    expect(cloneCalls).toBe(3);
    expect(updateTaskState).toHaveBeenCalledWith("t1", "failed", expect.objectContaining({
      failureReason: expect.stringContaining("拉取超时"),
    }));
  });

  it("fails on upload size mismatch", async () => {
    execSync.mockReturnValue(Buffer.from(""));
    statObject.mockResolvedValue({ size: 999 });
    vi.useFakeTimers();
    const p = cloneAndUpload("t1", "https://x/repo.git", "main", "bucket");
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();
    expect(updateTaskState).toHaveBeenCalledWith("t1", "failed", expect.anything());
  });
});
