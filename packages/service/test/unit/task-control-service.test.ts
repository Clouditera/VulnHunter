import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  task: null as any,
  updates: [] as any[],
  stopped: [] as string[],
  reset: [] as string[],
  cleaned: [] as string[],
  notified: [] as any[],
  busy: false,
};

vi.mock("../../src/features/tasks/storage.js", () => ({
  getTaskById: vi.fn(async () => state.task),
  updateTaskState: vi.fn(async (...args: any[]) => state.updates.push(args)),
  queueTaskForResume: vi.fn(async (...args: any[]) => state.updates.push(["queueTaskForResume", ...args])),
  resetTaskForRestart: vi.fn(async (taskId: string) => state.reset.push(taskId)),
}));

vi.mock("../../src/features/workers/scan-worker.js", () => ({
  stopScanWorker: vi.fn(async (taskId: string) => state.stopped.push(taskId)),
  cleanupScanWorkDir: vi.fn((dataDir: string, taskId: string, cleanupImage?: string) => state.cleaned.push(`${dataDir}:${taskId}:${cleanupImage ?? ""}`)),
}));

vi.mock("../../src/features/notifications/index.js", () => ({
  notify: vi.fn((event: any) => state.notified.push(event)),
}));

vi.mock("../../src/features/tasks/operation-lock.js", () => ({
  assertNoActiveOperation: vi.fn(async () => {
    if (state.busy) {
      const err = new Error("active report operation") as Error & { code?: string; active?: string };
      err.code = "ERR_TASK_BUSY";
      err.active = "report";
      throw err;
    }
  }),
}));

vi.mock("../../src/infra/minio/client.js", () => ({
  getMinio: vi.fn(() => ({
    listObjects: vi.fn(() => {
      const { Readable } = require("node:stream");
      return Readable.from([]);
    }),
    removeObjects: vi.fn(async () => undefined),
  })),
}));

const { cancelTask, pauseTask, resumeTask, restartTask, TaskControlError } = await import("../../src/features/tasks/control-service.js");

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    project_name: "demo",
    state: "running",
    created_by: "user-1",
    ...overrides,
  } as any;
}

describe("task control service", () => {
  beforeEach(() => {
    state.task = null;
    state.updates = [];
    state.stopped = [];
    state.reset = [];
    state.cleaned = [];
    state.notified = [];
    state.busy = false;
  });

  it("cancels a running task and stops the worker", async () => {
    state.task = makeTask({ state: "running" });
    const result = await cancelTask("task-1");
    expect(result.state).toBe("cancelled");
    expect(state.updates[0][1]).toBe("cancelled");
    expect(state.stopped).toEqual(["task-1"]);
    expect(state.notified[0]).toMatchObject({ type: "task_state", taskId: "task-1", state: "cancelled" });
  });

  it("pauses a running task and stops the worker", async () => {
    state.task = makeTask({ state: "running" });
    const result = await pauseTask("task-1");
    expect(result.state).toBe("paused");
    expect(state.updates[0][1]).toBe("paused");
    expect(state.stopped).toEqual(["task-1"]);
  });

  it("resumes a paused task by queuing it", async () => {
    state.task = makeTask({ state: "paused" });
    const result = await resumeTask("task-1");
    expect(result.state).toBe("queued");
    expect(state.notified[0]).toMatchObject({ type: "task_state", taskId: "task-1", state: "queued" });
  });

  it("restarts a completed task with cleanup", async () => {
    state.task = makeTask({ state: "completed" });
    const result = await restartTask("task-1", {
      dataDir: "/tmp/vh",
      minio: { bucket: "vulnhunt" },
      docker: { workerImage: "vulnhunt-worker:1.0.3" },
    } as any);
    expect(result.state).toBe("queued");
    expect(state.reset).toEqual(["task-1"]);
    expect(state.cleaned).toEqual(["/tmp/vh:task-1:vulnhunt-worker:1.0.3"]);
  });

  it("cancels a queued task without stopping a worker", async () => {
    state.task = makeTask({ state: "queued" });
    const result = await cancelTask("task-1");
    expect(result.state).toBe("cancelled");
    expect(state.updates[0][1]).toBe("cancelled");
    expect(state.stopped).toEqual([]);
  });

  it("blocks cancel, pause, and restart when operation lock is busy", async () => {
    state.busy = true;

    state.task = makeTask({ state: "running" });
    await expect(cancelTask("task-1")).rejects.toMatchObject({ code: "ERR_TASK_BUSY" });
    await expect(pauseTask("task-1")).rejects.toMatchObject({ code: "ERR_TASK_BUSY" });

    state.task = makeTask({ state: "completed" });
    await expect(restartTask("task-1", { dataDir: "/tmp/vh", minio: { bucket: "vulnhunt" } } as any))
      .rejects.toMatchObject({ code: "ERR_TASK_BUSY" });

    expect(state.updates).toEqual([]);
    expect(state.stopped).toEqual([]);
    expect(state.reset).toEqual([]);
  });
});
