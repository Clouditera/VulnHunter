import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * task-c832309f / fish 2026-08-08: continue mode reuses metadata.prepare and
 * does NOT spawn the prepare worker. Missing/invalid metadata falls back.
 */

const m = vi.hoisted(() => ({
  prepareResult: {
    project_complete: true,
    sandbox_type: "linux-docker" as string | null,
    reason: "complete" as string,
  },
  dynamicEnabled: false,
  events: [] as any[],
  metadataPatches: [] as any[],
  runPrepareWorker: vi.fn(async () => m.prepareResult),
}));

vi.mock("../../src/features/prepare/contract.js", async () => {
  const actual = await vi.importActual<any>("../../src/features/prepare/contract.js");
  return { ...actual, isDynamicEnabled: () => m.dynamicEnabled };
});
vi.mock("../../src/features/events/event-store.js", () => ({
  appendEvent: vi.fn((_taskId: string, event: any) => {
    m.events.push(event);
    return { seq: m.events.length, event };
  }),
}));
vi.mock("../../src/features/events/ws-live-log.js", () => ({ broadcastEvent: vi.fn() }));
vi.mock("../../src/features/tasks/storage.js", () => ({
  mergeTaskMetadata: vi.fn(async (_taskId: string, patch: any) => {
    m.metadataPatches.push(patch);
  }),
  claimQueuedScanTasks: vi.fn(),
  failSchedulerClaim: vi.fn(),
  getRunningTaskIds: vi.fn(),
  getTaskById: vi.fn(),
  markSchedulerClaimRunning: vi.fn(),
  renewSchedulerClaim: vi.fn(),
  clearContinueMode: vi.fn(),
  getSchedulerClaim: vi.fn(),
  listStuckDeadlineRunningTasks: vi.fn(),
  requeueSchedulerClaim: vi.fn(),
  updateTaskState: vi.fn(),
  SCHEDULER_CLAIM_HEARTBEAT_MS: 5000,
}));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/infra/db/client.js", () => ({ getDb: vi.fn() }));
vi.mock("../../src/features/workers/docker-client.js", () => ({
  subscribeToDockerEvents: vi.fn(),
  ensureWorkDir: vi.fn(),
}));
vi.mock("../../src/features/workers/scan-worker.js", () => ({
  spawnScanWorker: vi.fn(),
  getHostWorkDir: vi.fn(() => "/tmp/w"),
  hasRunningScanWorkerByClaim: vi.fn(),
  stopScanWorker: vi.fn(),
  stopScanWorkerByClaim: vi.fn(),
}));
vi.mock("../../src/features/workers/scheduler-workspace.js", () => ({
  cleanupSchedulerWorkspace: vi.fn(),
  getSchedulerPrepareDir: vi.fn(),
  publishSchedulerWorkspace: vi.fn(),
}));
vi.mock("../../src/features/workers/reconciler.js", () => ({
  reconcileSchedulerClaims: vi.fn(),
}));
vi.mock("../../src/features/workers/minio-download.js", () => ({
  downloadObjectWithRetry: vi.fn(),
}));
vi.mock("../../src/features/settings/storage.js", () => ({
  getDefaultCredential: vi.fn(),
  getCredentialById: vi.fn(),
}));
vi.mock("../../src/infra/crypto/master-key-vault.js", () => ({
  CredentialDecryptError: class extends Error {},
  CredentialKeyUnavailableError: class extends Error {},
}));
vi.mock("../../src/features/settings/credential-env.js", () => ({
  credentialToWorkerEnv: vi.fn(),
  writeWorkerModelsJson: vi.fn(),
}));
vi.mock("../../src/features/events/event-tail.js", () => ({
  startTailing: vi.fn(),
  stopTailing: vi.fn(),
}));
vi.mock("../../src/features/tasks/scan-duration.js", () => ({
  SCAN_FALLBACK_MARGIN_S: 60,
}));

const { TaskScheduler } = await import("../../src/features/workers/scheduler.js");

const token = "11111111-1111-4111-8111-111111111111";

function makeTask(prepareMeta?: Record<string, unknown> | null) {
  return {
    id: "task-continue-1",
    credential_id: null,
    source_meta: {},
    started_at: null,
    metadata: prepareMeta === null || prepareMeta === undefined ? {} : { prepare: prepareMeta },
    scheduler_claim: { token, mode: "continue" },
  } as any;
}

function scheduler(): TaskScheduler {
  return new TaskScheduler({ dataDir: "/tmp", minio: { bucket: "b" } } as any);
}

describe("resolveContinuePrepare (task-c832309f)", () => {
  beforeEach(() => {
    m.events = [];
    m.metadataPatches = [];
    m.dynamicEnabled = false;
    m.prepareResult = {
      project_complete: true,
      sandbox_type: "linux-docker",
      reason: "complete",
    };
    m.runPrepareWorker.mockClear();
    m.runPrepareWorker.mockImplementation(async () => m.prepareResult);
  });

  it("reuses metadata.prepare and does NOT spawn prepare worker", async () => {
    const task = makeTask({
      project_complete: true,
      sandbox_type: "linux-docker",
      reason: "complete",
      at: "2026-08-08T00:00:00.000Z",
    });
    const result = await (scheduler() as any).resolveContinuePrepare(task, token, "/tmp/w");
    expect(result).toEqual({
      project_complete: true,
      sandbox_type: "linux-docker",
      reason: "complete",
    });
    expect(m.runPrepareWorker).not.toHaveBeenCalled();
    const completed = m.events.find((e) => e.type === "prepare_completed");
    expect(completed).toMatchObject({
      project_complete: true,
      sandbox_type: "linux-docker",
      reason: "complete",
      reused: true,
    });
    expect(m.events.some((e) => e.type === "prepare_started")).toBe(false);
  });

  it("missing metadata.prepare hard-fails (no live-prepare fallback since internalization)", async () => {
    const task = makeTask(null);
    await expect(
      (scheduler() as any).resolveContinuePrepare(task, token, "/tmp/w"),
    ).rejects.toThrow(/缺少首次运行的完整性判定结果/);
    expect(m.events.find((e) => e.type === "prepare_failed")).toMatchObject({ reused: true });
  });

  it("invalid metadata.prepare (bad reason) hard-fails the same way", async () => {
    const task = makeTask({
      project_complete: true,
      sandbox_type: null,
      reason: "not-a-real-reason",
    });
    await expect(
      (scheduler() as any).resolveContinuePrepare(task, token, "/tmp/w"),
    ).rejects.toThrow(/缺少首次运行的完整性判定结果/);
  });

  it("reused incomplete result still interrupts (branch matrix)", async () => {
    const task = makeTask({
      project_complete: false,
      sandbox_type: null,
      reason: "partial_source",
    });
    await expect(
      (scheduler() as any).resolveContinuePrepare(task, token, "/tmp/w"),
    ).rejects.toThrow(/源码不完整/);
    expect(m.runPrepareWorker).not.toHaveBeenCalled();
    expect(m.events.find((e) => e.type === "prepare_failed")).toMatchObject({
      reason: "source_incomplete",
      reused: true,
    });
  });

  it("reused complete + dynamic on + null sandbox → O1 fail", async () => {
    m.dynamicEnabled = true;
    const task = makeTask({
      project_complete: true,
      sandbox_type: null,
      reason: "no_compatible_sandbox",
    });
    await expect(
      (scheduler() as any).resolveContinuePrepare(task, token, "/tmp/w"),
    ).rejects.toThrow(/未找到兼容的沙箱类型/);
    expect(m.runPrepareWorker).not.toHaveBeenCalled();
    expect(m.events.find((e) => e.type === "prepare_failed")).toMatchObject({
      reason: "no_compatible_sandbox",
      reused: true,
    });
  });

  it("reused sandbox_type is returned for allocateSandboxForTask path", async () => {
    const task = makeTask({
      project_complete: true,
      sandbox_type: "linux-qemu-system",
      reason: "complete",
    });
    const result = await (scheduler() as any).resolveContinuePrepare(task, token, "/tmp/w");
    expect(result.sandbox_type).toBe("linux-qemu-system");
    expect(m.runPrepareWorker).not.toHaveBeenCalled();
  });
});
