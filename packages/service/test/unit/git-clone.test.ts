import { beforeEach, describe, expect, it, vi } from "vitest";

const execFile = vi.fn();
const updateTaskState = vi.fn(async () => undefined);
const getTaskById = vi.fn(async () => ({ state: "preparing" }) as never);
const appendEvent = vi.fn();
const uploadFile = vi.fn(async () => undefined);
const statObject = vi.fn(async () => ({ size: 100 }));

vi.mock("node:child_process", () => ({ execFile }));
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
vi.mock("../../src/features/tasks/storage.js", () => ({ updateTaskState, getTaskById }));
vi.mock("../../src/features/events/event-store.js", () => ({ appendEvent }));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { cloneAndUpload } = await import("../../src/features/files/git-clone.js");

/** execFile(cmd, args, opts, cb) — invoke cb async to mimic non-blocking. */
function ok() {
  execFile.mockImplementation((_c, _a, _o, cb) => { setImmediate(() => cb(null)); return {} as never; });
}
function fail(stderr: string) {
  execFile.mockImplementation((_c, _a, _o, cb) => {
    setImmediate(() => cb(Object.assign(new Error("fail"), { stderr })));
    return {} as never;
  });
}

describe("cloneAndUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statObject.mockResolvedValue({ size: 100 });
    getTaskById.mockResolvedValue({ state: "preparing" } as never);
  });

  it("clones once and uploads on success, then transitions preparing→queued", async () => {
    ok();
    await cloneAndUpload("t1", "https://x/repo.git", "main", "bucket");
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(updateTaskState).toHaveBeenCalledWith("t1", "queued");
  });

  it("skips queued transition if task was cancelled during clone", async () => {
    ok();
    getTaskById.mockResolvedValue({ state: "cancelled" } as never);
    await cloneAndUpload("t1", "https://x/repo.git", "main", "bucket");
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(updateTaskState).not.toHaveBeenCalled();
  });

  it("retries timeout failures 3 times then fails with user-readable reason", async () => {
    fail("ETIMEDOUT: connection timed out");
    vi.useFakeTimers();
    const p = cloneAndUpload("t1", "https://x/repo.git", "main", "bucket");
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();
    const cloneCalls = execFile.mock.calls.filter((c) => c[1]?.[0] === "clone").length;
    expect(cloneCalls).toBe(3);
    expect(updateTaskState).toHaveBeenCalledWith("t1", "failed", expect.objectContaining({
      failureReason: expect.stringContaining("拉取超时"),
    }));
  });

  it("marks invalid git urls failed without invoking git", async () => {
    ok();
    await cloneAndUpload("t1", "/workspace", undefined, "bucket");

    expect(execFile).not.toHaveBeenCalled();
    expect(updateTaskState).toHaveBeenCalledWith("t1", "failed", expect.objectContaining({
      failureReason: expect.stringContaining("无法访问该源码仓库"),
    }));
  });

  it("does not retry non-existent repo (clones once, repo-unreachable reason)", async () => {
    fail("fatal: repository not found");
    await cloneAndUpload("t1", "https://x/missing.git", "main", "bucket");
    const cloneCalls = execFile.mock.calls.filter((c) => c[1]?.[0] === "clone").length;
    expect(cloneCalls).toBe(1);
    expect(updateTaskState).toHaveBeenCalledWith("t1", "failed", expect.objectContaining({
      failureReason: expect.stringContaining("无法访问该源码仓库"),
    }));
  });

  it("fails on upload size mismatch", async () => {
    ok();
    statObject.mockResolvedValue({ size: 999 });
    vi.useFakeTimers();
    const p = cloneAndUpload("t1", "https://x/repo.git", "main", "bucket");
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();
    expect(updateTaskState).toHaveBeenCalledWith("t1", "failed", expect.anything());
  });
});
