import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const token = "11111111-1111-4111-8111-111111111111";
  const task = {
    id: "task-1", state: "preparing", credential_id: null, source_meta: {}, started_at: null,
    scheduler_claim: { version: 1, token, owner_instance: "22222222-2222-4222-8222-222222222222", claimed_at: new Date().toISOString(), lease_expires_at: new Date(Date.now()+90000).toISOString(), deadline_at: new Date(Date.now()+900000).toISOString(), mode: "fresh" },
  } as any;
  return {
    token, task,
    claim: vi.fn(), renew: vi.fn(async () => true), mark: vi.fn(async () => true), fail: vi.fn(async () => false),
    extract: vi.fn(async () => { await new Promise((r) => setTimeout(r, 80)); }),
    publish: vi.fn(async () => undefined), spawn: vi.fn(async () => "worker-1"),
    prepare: vi.fn(async () => ({ project_complete: true, sandbox_type: null, reason: "complete" })),
    reconcile: vi.fn(async () => undefined), notify: vi.fn(),
  };
});

vi.mock("../../src/infra/db/client.js", () => ({ getDb: () => vi.fn(async () => [{ config: { max_parallel_scan: 3, youngflow_max_parallel: 3 } }]) }));
vi.mock("../../src/features/tasks/storage.js", async () => {
  const actual = await vi.importActual<any>("../../src/features/tasks/storage.js");
  return {
    ...actual,
    claimQueuedScanTasks: m.claim,
    renewSchedulerClaim: m.renew,
    markSchedulerClaimRunning: m.mark,
    failSchedulerClaim: m.fail,
    getRunningTaskIds: vi.fn(async () => []),
    getTaskById: vi.fn(async () => ({ ...m.task, state: "running" })),
    listStuckDeadlineRunningTasks: vi.fn(async () => []),
    mergeTaskMetadata: vi.fn(async () => undefined),
  };
});
vi.mock("../../src/features/workers/reconciler.js", () => ({ reconcileSchedulerClaims: m.reconcile }));
vi.mock("../../src/features/workers/docker-client.js", () => ({ subscribeToDockerEvents: vi.fn(), ensureWorkDir: vi.fn() }));
vi.mock("../../src/features/workers/scan-worker.js", () => ({
  spawnScanWorker: m.spawn, getHostWorkDir: () => "/tmp/scheduler-single-owner", hasRunningScanWorkerByClaim: vi.fn(async () => true),
  stopScanWorker: vi.fn(async () => undefined), stopScanWorkerByClaim: vi.fn(),
}));
vi.mock("../../src/features/workers/scheduler-workspace.js", () => ({
  getSchedulerPrepareDir: () => "/tmp/scheduler-single-owner/stage", cleanupSchedulerWorkspace: vi.fn(), publishSchedulerWorkspace: m.publish,
}));
vi.mock("../../src/features/workers/prepare-worker.js", () => ({
  isDynamicEnabled: () => false,
  runPrepareWorker: m.prepare,
  stopPrepareWorkerByClaim: vi.fn(async () => undefined),
}));
vi.mock("../../src/features/workers/minio-download.js", () => ({ downloadObjectWithRetry: vi.fn() }));
vi.mock("../../src/features/settings/storage.js", () => ({ getDefaultCredential: vi.fn(async () => ({ proto_type: "x", model_id: "m" })), getCredentialById: vi.fn() }));
vi.mock("../../src/features/settings/credential-env.js", () => ({ credentialToWorkerEnv: () => ({}) }));
vi.mock("../../src/features/events/event-tail.js", () => ({ startTailing: vi.fn(), stopTailing: vi.fn() }));
vi.mock("../../src/features/findings/indexer.js", () => ({ indexFindings: vi.fn() }));
vi.mock("../../src/features/workers/sync-outputs.js", () => ({ syncOutputsToMinio: vi.fn(), downloadOutputsFromMinio: vi.fn() }));
vi.mock("../../src/infra/minio/client.js", () => ({ getMinio: () => ({ statObject: vi.fn(async () => true) }) }));
vi.mock("../../src/features/poc/scheduler.js", () => ({ tickPocScheduler: vi.fn(async () => undefined), onEvalContainerDie: vi.fn(), onPocRunContainerDie: vi.fn() }));
vi.mock("../../src/features/chat/chat-session.js", () => ({ onChatContainerDie: vi.fn() }));
vi.mock("../../src/features/reports/report-worker.js", () => ({ onReportContainerDie: vi.fn() }));
vi.mock("../../src/features/notifications/index.js", () => ({ notify: m.notify }));
vi.mock("../../src/features/source-archives/extract.js", () => ({ extractSourceArchive: m.extract }));
vi.mock("../../src/features/source-archives/policy.js", () => ({ getSourceArchivePolicy: vi.fn(async () => ({})) }));
vi.mock("../../src/features/source-archives/detect.js", () => ({ resolveArchiveIdentity: () => ({ minioKey: "k", filename: "source.zip" }) }));

import { TaskScheduler } from "../../src/features/workers/scheduler.js";

describe("scheduler overlapping ticks", () => {
  it("prepares, publishes, creates and starts exactly once", async () => {
    let calls = 0;
    m.claim.mockImplementation(async () => calls++ === 0 ? [m.task] : []);
    const scheduler = new TaskScheduler({ dataDir: "/tmp", minio: { bucket: "b" } } as any);
    await Promise.all([(scheduler as any).tick(), (scheduler as any).tick(), (scheduler as any).tick()]);
    expect(m.claim).toHaveBeenCalledTimes(3);
    expect(m.extract).toHaveBeenCalledTimes(1);
    expect(m.publish).toHaveBeenCalledTimes(1);
    expect(m.prepare).toHaveBeenCalledTimes(1);
    expect(m.spawn).toHaveBeenCalledTimes(1);
    expect(m.mark).toHaveBeenCalledTimes(1);
  });
});
