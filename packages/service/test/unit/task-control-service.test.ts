import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  task: null as any,
  updates: [] as any[],
  stopped: [] as string[],
  stoppedClaims: [] as string[],
  cancelledClaims: [] as string[],
  cleanedClaims: [] as string[],
  paused: [] as string[],
  unpaused: [] as string[],
  pauseCount: 1,
  unpauseCount: 1,
  reset: [] as string[],
  continued: [] as any[],
  cleaned: [] as string[],
  notified: [] as any[],
  busy: false,
  sandboxStopped: [] as string[],
  sandboxResumed: [] as string[],
};

vi.mock("../../src/features/tasks/storage.js", () => ({
  getTaskById: vi.fn(async () => state.task),
  updateTaskState: vi.fn(async (...args: any[]) => state.updates.push(args)),
  queueTaskForResume: vi.fn(async (...args: any[]) => state.updates.push(["queueTaskForResume", ...args])),
  queueTaskForContinue: vi.fn(async (...args: any[]) => state.continued.push(args)),
  resetTaskForRestart: vi.fn(async (taskId: string) => state.reset.push(taskId)),
  getSchedulerClaim: vi.fn((task: any) => task.metadata?._scan_scheduler_claim ?? null),
  cancelSchedulerClaim: vi.fn(async (taskId: string, token: string) => { state.cancelledClaims.push(`${taskId}:${token}`); return true; }),
}));

vi.mock("../../src/features/workers/scan-worker.js", () => ({
  stopScanWorker: vi.fn(async (taskId: string) => state.stopped.push(taskId)),
  stopScanWorkerByClaim: vi.fn(async (taskId: string, token: string) => state.stoppedClaims.push(`${taskId}:${token}`)),
  getHostWorkDir: vi.fn((dataDir: string, taskId: string) => `${dataDir}/workspaces/${taskId}`),
  pauseScanWorker: vi.fn(async (taskId: string) => { state.paused.push(taskId); return state.pauseCount; }),
  unpauseScanWorker: vi.fn(async (taskId: string) => { state.unpaused.push(taskId); return state.unpauseCount; }),
  cleanupScanWorkDir: vi.fn((dataDir: string, taskId: string, cleanupImage?: string) => state.cleaned.push(`${dataDir}:${taskId}:${cleanupImage ?? ""}`)),
}));

vi.mock("../../src/features/workers/scheduler-workspace.js", () => ({
  cleanupSchedulerWorkspace: vi.fn(async (path: string, token: string) => state.cleanedClaims.push(`${path}:${token}`)),
}));

// H2: sandbox lifecycle is a no-op without a mapping; stop/resume calls are
// recorded separately so existing container assertions stay untouched.
vi.mock("../../src/features/dynamic/provider.js", () => ({
  getDynamicProvider: () => ({
    stopSandboxForTask: async (taskId: string) => { state.sandboxStopped.push(taskId); },
    resumeSandboxForTask: async (taskId: string) => { state.sandboxResumed.push(taskId); },
    isConfigured: () => true,
  }),
}));

vi.mock("../../src/infra/config.js", () => ({ loadConfig: () => ({ dataDir: "/data" }) }));

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

const { cancelTask, continueTask, pauseTask, resumeTask, restartTask, TaskControlError } = await import("../../src/features/tasks/control-service.js");

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    project_name: "example",
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
    state.stoppedClaims = [];
    state.cancelledClaims = [];
    state.cleanedClaims = [];
    state.paused = [];
    state.unpaused = [];
    state.pauseCount = 1;
    state.unpauseCount = 1;
    state.reset = [];
    state.continued = [];
    state.cleaned = [];
    state.notified = [];
    state.busy = false;
    state.sandboxStopped = [];
    state.sandboxResumed = [];
  });

  it("cancels a running task and stops the worker", async () => {
    state.task = makeTask({ state: "running" });
    const result = await cancelTask("task-1");
    expect(result.state).toBe("cancelled");
    expect(state.updates[0][1]).toBe("cancelled");
    expect(state.stopped).toEqual(["task-1"]);
    // H2 §4: cancel also stops (keeps) the sandbox instance.
    expect(state.sandboxStopped).toEqual(["task-1"]);
    expect(state.notified[0]).toMatchObject({ type: "task_state", taskId: "task-1", state: "cancelled" });
  });

  it("pauses a running task by freezing the container (docker pause)", async () => {
    state.task = makeTask({ state: "running" });
    const result = await pauseTask("task-1");
    expect(result.state).toBe("paused");
    expect(state.updates[0][1]).toBe("paused");
    expect(state.paused).toEqual(["task-1"]);
    expect(state.stopped).toEqual([]);
    expect(state.sandboxStopped).toEqual(["task-1"]);
  });

  it("falls back to stop when no container could be paused", async () => {
    state.task = makeTask({ state: "running" });
    state.pauseCount = 0;
    const result = await pauseTask("task-1");
    expect(result.state).toBe("paused");
    expect(state.paused).toEqual(["task-1"]);
    expect(state.stopped).toEqual(["task-1"]);
    expect(state.sandboxStopped).toEqual(["task-1"]);
  });

  it("resumes a paused task by unpausing the frozen container", async () => {
    state.task = makeTask({ state: "paused" });
    const result = await resumeTask("task-1");
    expect(result.state).toBe("queued");
    // H2 §4: sandbox resumes before the worker container is unpaused.
    expect(state.sandboxResumed).toEqual(["task-1"]);
    expect(state.unpaused).toEqual(["task-1"]);
    // No checkpoint re-queue when the container was unpaused in place.
    expect(state.updates.some((u) => u[0] === "queueTaskForResume")).toBe(false);
    expect(state.notified[0]).toMatchObject({ type: "task_state", taskId: "task-1", state: "running" });
  });

  it("falls back to --continue when no paused container exists (resume retired)", async () => {
    state.task = makeTask({ state: "paused" });
    state.unpauseCount = 0;
    const result = await resumeTask("task-1");
    expect(result.state).toBe("queued");
    expect(state.unpaused).toEqual(["task-1"]);
    expect(state.updates.some((u) => u[0] === "queueTaskForResume")).toBe(true);
    expect(state.notified[0]).toMatchObject({ type: "task_state", taskId: "task-1", state: "queued" });
  });

  it("restarts a completed task with cleanup", async () => {
    state.task = makeTask({ state: "completed" });
    const result = await restartTask("task-1", {
      dataDir: "/tmp/vh",
      minio: { bucket: "artifact-store" },
      docker: { workerImage: "vulnhunter-worker:1.0.3" },
    } as any);
    expect(result.state).toBe("queued");
    expect(state.reset).toEqual(["task-1"]);
    expect(state.cleaned).toEqual(["/tmp/vh:task-1:vulnhunter-worker:1.0.3"]);
  });

  it("continues a completed task without clearing findings", async () => {
    state.task = makeTask({ state: "completed" });
    const result = await continueTask("task-1", { auditFocus: "auth", scanTimeout: 1500 });
    expect(result.state).toBe("queued");
    // continue must NOT reset/clear findings
    expect(state.reset).toEqual([]);
    expect(state.cleaned).toEqual([]);
    expect(state.continued).toEqual([["task-1", { auditFocus: "auth", scanTimeout: 1500 }]]);
    expect(state.notified[0]).toMatchObject({ type: "task_state", taskId: "task-1", state: "queued" });
  });

  it("rejects continue on a running task", async () => {
    state.task = makeTask({ state: "running" });
    await expect(continueTask("task-1")).rejects.toMatchObject({ code: "ERR_INVALID_STATE" });
    expect(state.continued).toEqual([]);
  });

  it("allows continue on failed and cancelled tasks", async () => {
    state.task = makeTask({ state: "failed" });
    await continueTask("task-1");
    state.task = makeTask({ state: "cancelled" });
    await continueTask("task-1");
    expect(state.continued.length).toBe(2);
  });

  it("cancels a queued task without stopping a worker", async () => {
    state.task = makeTask({ state: "queued" });
    const result = await cancelTask("task-1");
    expect(result.state).toBe("cancelled");
    expect(state.updates[0][1]).toBe("cancelled");
    expect(state.stopped).toEqual([]);
  });

  it("cancels a preparing task only through its exact claim token", async () => {
    const token = "11111111-1111-4111-8111-111111111111";
    state.task = makeTask({ state: "preparing", metadata: { _scan_scheduler_claim: { token } } });
    const result = await cancelTask("task-1");
    expect(result.state).toBe("cancelled");
    expect(state.cancelledClaims).toEqual([`task-1:${token}`]);
    expect(state.stoppedClaims).toEqual([`task-1:${token}`]);
    expect(state.cleanedClaims).toEqual([`/data/workspaces/task-1:${token}`]);
    expect(state.updates).toEqual([]);
  });

  it("blocks cancel, pause, and restart when operation lock is busy", async () => {
    state.busy = true;

    state.task = makeTask({ state: "running" });
    await expect(cancelTask("task-1")).rejects.toMatchObject({ code: "ERR_TASK_BUSY" });
    await expect(pauseTask("task-1")).rejects.toMatchObject({ code: "ERR_TASK_BUSY" });

    state.task = makeTask({ state: "completed" });
    await expect(restartTask("task-1", { dataDir: "/tmp/vh", minio: { bucket: "artifact-store" } } as any))
      .rejects.toMatchObject({ code: "ERR_TASK_BUSY" });
    await expect(continueTask("task-1")).rejects.toMatchObject({ code: "ERR_TASK_BUSY" });

    expect(state.updates).toEqual([]);
    expect(state.stopped).toEqual([]);
    expect(state.reset).toEqual([]);
    expect(state.continued).toEqual([]);
  });
});
