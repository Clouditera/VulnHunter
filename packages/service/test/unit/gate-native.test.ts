import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Engine-native gate (spec §4/§8):
 * - POST /internal/sandbox-plane/apply: ok (inject called, metadata written,
 *   no CAS) / quota / capacity / plane_unavailable / type_unavailable /
 *   non-fresh 409 / non-preparing 401 / malformed 400.
 * - Route-event perception via the scheduler's gate handler: continue with
 *   evidence → CAS + prepare_completed; continue missing evidence → dead
 *   (gate_evidence_missing); dynamic without alloc → dead; end reasons →
 *   prepare_failed + claim failed; malformed route events tolerated.
 */

const m = vi.hoisted(() => ({
  // storage
  taskById: null as any,
  claim: { token: "11111111-1111-4111-8111-111111111111", mode: "fresh" } as any,
  markedRunning: true,
  markedRunningCalls: 0,
  failClaimResult: true,
  failClaimCalls: 0,
  metadataPatches: [] as any[],
  events: [] as any[],
  // sandbox
  ensureSandboxResult: { mapping: { sandbox_id: "sb-1", profile_id: "linux-docker" }, reused: false },
  ensureSandboxError: null as any,
  profile: { id: "linux-docker", available: true },
  privateKey: "key",
  // docker
  containers: [] as any[],
  injected: 0,
  notified: [] as any[],
}));

vi.mock("../../src/features/tasks/storage.js", () => ({
  getSchedulerClaim: () => m.claim,
  getTaskById: vi.fn(async () => m.taskById),
  markSchedulerClaimRunning: vi.fn(async () => { m.markedRunningCalls++; return m.markedRunning; }),
  failSchedulerClaim: vi.fn(async () => { m.failClaimCalls++; return m.failClaimResult; }),
  mergeTaskMetadata: vi.fn(async (_t: string, patch: any) => { m.metadataPatches.push(patch); }),
  claimQueuedScanTasks: vi.fn(async () => []),
  renewSchedulerClaim: vi.fn(async () => true),
  clearContinueMode: vi.fn(),
  getRunningTaskIds: vi.fn(async () => []),
  listStuckDeadlineRunningTasks: vi.fn(async () => []),
  requeueSchedulerClaim: vi.fn(),
  updateTaskState: vi.fn(),
  SCHEDULER_CLAIM_HEARTBEAT_MS: 5000,
}));
vi.mock("../../src/features/events/event-store.js", () => ({
  appendEvent: vi.fn((_t: string, event: any) => { m.events.push(event); return { seq: m.events.length, event }; }),
}));
vi.mock("../../src/features/events/ws-live-log.js", () => ({ broadcastEvent: vi.fn() }));
vi.mock("../../src/infra/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../src/infra/config.js", () => ({
  loadConfig: () => ({
    dataDir: "/tmp/gate-test",
    sandboxSshHostOverride: null, sandboxSshBastion: null,
    sandboxSshBastionHostKey: null, sandboxSshBastionIdentity: null,
  }),
}));
vi.mock("../../src/features/sandboxes/lifecycle.js", () => ({
  ensureSandboxForTask: vi.fn(async () => {
    if (m.ensureSandboxError) throw m.ensureSandboxError;
    return m.ensureSandboxResult;
  }),
  stopSandboxForTask: vi.fn(async () => undefined),
  reconcileSandboxes: vi.fn(async () => undefined),
  SandboxQuotaError: class extends Error {},
}));
vi.mock("../../src/features/sandbox-plane/client.js", () => ({
  SandboxPlaneCapacityError: class extends Error {},
  SandboxPlaneUnavailableError: class extends Error {},
  listSandboxPlaneProfiles: vi.fn(async () => []),
  getSandboxPlaneProfile: vi.fn(async () => m.profile),
}));
vi.mock("../../src/features/sandboxes/index.js", () => ({
  getTaskSandbox: vi.fn(async () => null),
  peekTaskSshPrivateKey: vi.fn(async () => m.privateKey),
}));
vi.mock("../../src/features/workers/sandbox-inject.js", () => ({
  injectSandboxFiles: vi.fn(async () => { m.injected++; }),
  renderInjectionFiles: vi.fn(() => [{ containerPath: "/run/vulnhunter/ssh/config", content: "x", mode: 0o444 }]),
  renderSandboxMd: vi.fn(() => "# sandbox usage"),
  scanOutputsForKeyMaterial: vi.fn(async () => []),
}));
vi.mock("../../src/features/workers/docker-client.js", () => ({
  getDocker: () => ({
    listContainers: vi.fn(async () => m.containers),
    getContainer: (id: string) => ({ id, stop: vi.fn(), exec: vi.fn() }),
  }),
  LABEL_TASK_ID: "vulnhunter.task_id",
  LABEL_TASK_TYPE: "vulnhunter.task_type",
  LABEL_SCHEDULER_CLAIM: "vulnhunter.scheduler_claim",
  subscribeToDockerEvents: vi.fn(),
  ensureWorkDir: vi.fn(),
  listManagedContainers: vi.fn(async () => []),
}));
vi.mock("../../src/infra/db/client.js", () => ({ getDb: vi.fn() }));
vi.mock("../../src/notifications/index.js", () => ({
  notify: vi.fn((n: any) => { m.notified.push(n); }),
}));
vi.mock("../../src/features/workers/reconciler.js", () => ({ reconcileSchedulerClaims: vi.fn() }));
vi.mock("../../src/features/workers/minio-download.js", () => ({ downloadObjectWithRetry: vi.fn() }));
vi.mock("../../src/features/settings/storage.js", () => ({
  getDefaultCredential: vi.fn(async () => ({ proto_type: "x", model_id: "m" })),
  getCredentialById: vi.fn(),
}));
vi.mock("../../src/infra/crypto/master-key-vault.js", () => ({
  CredentialDecryptError: class extends Error {},
  CredentialKeyUnavailableError: class extends Error {},
}));
vi.mock("../../src/features/settings/credential-env.js", () => ({
  credentialToWorkerEnv: vi.fn(() => ({})),
  writeWorkerModelsJson: vi.fn(async () => undefined),
}));
vi.mock("../../src/features/workers/scan-worker.js", () => ({
  spawnScanWorker: vi.fn(async () => "ctr-1"),
  getHostWorkDir: vi.fn(() => "/tmp/gate-test/workspaces/task-gate-1"),
  hasRunningScanWorkerByClaim: vi.fn(async () => true),
  stopScanWorker: vi.fn(),
  stopScanWorkerByClaim: vi.fn(),
}));
vi.mock("../../src/features/workers/scheduler-workspace.js", () => ({
  cleanupSchedulerWorkspace: vi.fn(async () => undefined),
  getSchedulerPrepareDir: vi.fn(),
  publishSchedulerWorkspace: vi.fn(async () => true),
}));
vi.mock("../../src/features/findings/indexer.js", () => ({ indexFindings: vi.fn(async () => 0) }));
vi.mock("../../src/features/workers/sync-outputs.js", () => ({
  syncOutputsToMinio: vi.fn(),
  downloadOutputsFromMinio: vi.fn(async () => ({ downloaded: 0 })),
}));
vi.mock("../../src/infra/minio/client.js", () => ({ getMinio: () => ({ statObject: vi.fn(async () => true) }) }));
vi.mock("../../src/features/chat/chat-session.js", () => ({ onChatContainerDie: vi.fn() }));
vi.mock("../../src/features/reports/report-worker.js", () => ({ onReportContainerDie: vi.fn() }));
vi.mock("../../src/features/source-archives/extract.js", () => ({ extractSourceArchive: vi.fn() }));
vi.mock("../../src/features/source-archives/policy.js", () => ({ getSourceArchivePolicy: vi.fn(async () => ({})) }));
vi.mock("../../src/features/source-archives/detect.js", () => ({ resolveArchiveIdentity: () => ({ minioKey: "k", filename: "s.zip" }) }));
vi.mock("../../src/features/tasks/scan-duration.js", () => ({
  SCAN_FALLBACK_MARGIN_S: 120,
  computeScanDeadlineAt: vi.fn(() => new Date().toISOString()),
}));

const { sandboxPlaneInternalRouter } = await import("../../src/features/sandbox-plane/routes.js");
const { TaskScheduler } = await import("../../src/features/workers/scheduler.js");
const { setEngineEventHandler } = await import("../../src/features/events/event-tail.js");
const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");

const token = "11111111-1111-4111-8111-111111111111";

function preparingTask(overrides: Record<string, unknown> = {}) {
  return { id: "task-gate-1", state: "preparing", source_meta: {}, metadata: {}, ...overrides } as any;
}

describe("POST /internal/sandbox-plane/apply", () => {
  beforeEach(() => {
    m.taskById = preparingTask();
    m.claim = { token, mode: "fresh" };
    m.markedRunningCalls = 0;
    m.ensureSandboxError = null;
    m.injected = 0;
    m.containers = [{ Id: "ctr-1", State: "running", Labels: {} }];
    m.profile = { id: "linux-docker", status: "available" };
    m.metadataPatches = [];
  });

  const post = (body: unknown, bearer = "task-gate-1") =>
    sandboxPlaneInternalRouter.request("/apply", {
      method: "POST",
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
      body: JSON.stringify(body),
    });

  it("401 when the task is not preparing", async () => {
    m.taskById = preparingTask({ state: "running" });
    const res = await post({ profile_id: "linux-docker" });
    expect(res.status).toBe(401);
  });

  it("409 when the claim is not fresh", async () => {
    m.claim = { token, mode: "continue" };
    const res = await post({ profile_id: "linux-docker" });
    expect(res.status).toBe(409);
  });

  it("400 on a malformed body", async () => {
    const res = await post({ nope: 1 });
    expect(res.status).toBe(400);
  });

  it("type_unavailable when the profile is missing or not available", async () => {
    m.profile = null;
    const res = await post({ profile_id: "gone" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, reason: "type_unavailable" });
  });

  it.each([
    ["quota", "SandboxQuotaError"],
    ["capacity", "SandboxPlaneCapacityError"],
    ["plane_unavailable", "SandboxPlaneUnavailableError"],
  ])("%s answers ok:false with the mapped reason", async (reason, errName) => {
    const mod = await import("../../src/features/sandboxes/lifecycle.js").catch(async () => await import("../../src/features/sandbox-plane/client.js"));
    const Ctor = (errName === "SandboxQuotaError"
      ? (await import("../../src/features/sandboxes/lifecycle.js")).SandboxQuotaError
      : errName === "SandboxPlaneCapacityError"
        ? (await import("../../src/features/sandbox-plane/client.js")).SandboxPlaneCapacityError
        : (await import("../../src/features/sandbox-plane/client.js")).SandboxPlaneUnavailableError);
    m.ensureSandboxError = new (Ctor as new (m: string) => Error)("x");
    const res = await post({ profile_id: "linux-docker" });
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, reason });
    expect(m.injected).toBe(0);
  });

  it("ok: allocates, injects into the running container, records alloc, no CAS", async () => {
    const res = await post({ profile_id: "linux-docker" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.sandbox_config).toBe("string");
    expect(m.injected).toBe(1);
    expect(m.metadataPatches).toContainEqual(expect.objectContaining({
      sandbox_alloc: expect.objectContaining({ sandbox_id: "sb-1" }),
    }));
    expect(m.markedRunningCalls).toBe(0);
  });
});

describe("gate route perception (EventTail engine events → scheduler)", () => {
  let scheduler: InstanceType<typeof TaskScheduler>;
  let hostWorkDir: string;

  beforeEach(() => {
    hostWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-perception-"));
    m.taskById = preparingTask();
    m.claim = { token, mode: "fresh" };
    m.events = []; m.metadataPatches = []; m.notified = [];
    m.markedRunning = true; m.markedRunningCalls = 0;
    m.failClaimCalls = 0; m.failClaimResult = true;
    scheduler = new TaskScheduler({ dataDir: "/tmp/gate-test", minio: { bucket: "b" } } as any);
  });

  const writeEvidence = (root: string) => {
    const k = path.join(root, "out", "knowledge");
    for (const rel of ["profiler.yaml", "wiki/index.md", "wiki/overview.md", "wiki/threat-model.md"]) {
      fs.mkdirSync(path.dirname(path.join(k, rel)), { recursive: true });
      fs.writeFileSync(path.join(k, rel), "content\n");
    }
  };
  const writeGate = (root: string, yaml: string) => {
    fs.mkdirSync(path.join(root, "out"), { recursive: true });
    fs.writeFileSync(path.join(root, "out", "gate.yaml"), yaml);
  };
  const fireRoute = (target: string) => {
    setEngineEventHandler("task-gate-1", null);
    (scheduler as any).registerGateRouteHandler("task-gate-1", token, hostWorkDir);
    const handler = (await0 => undefined) as never; // placeholder
    // Directly invoke the registered handler through the exported map
    const { __dispatchTest } = {} as never;
    // Simpler: the handler is registered via setEngineEventHandler; recover it
    // by dispatching through a FileTail is heavy — call the scheduler method
    // under test directly:
    void handler; void __dispatchTest;
    return (scheduler as any).handleGateRoute("task-gate-1", token, hostWorkDir, target);
  };

  it("continue with full evidence: persists prepare, CAS, prepare_completed event", async () => {
    writeEvidence(hostWorkDir);
    writeGate(hostWorkDir, "next: continue\nreason: complete\nsandbox_type: null\n");
    await fireRoute("cycle_join");
    expect(m.markedRunningCalls).toBe(1);
    expect(m.events.map((e) => e.type)).toContain("prepare_completed");
    expect(m.failClaimCalls).toBe(0);
  });

  it("continue with missing evidence: dead with gate_evidence_missing", async () => {
    writeGate(hostWorkDir, "next: continue\nreason: complete\nsandbox_type: null\n");
    await fireRoute("cycle_join");
    expect(m.failClaimCalls).toBe(1);
    expect(m.markedRunningCalls).toBe(0);
    const failed = m.events.find((e) => e.type === "prepare_failed");
    expect(failed).toMatchObject({ reason: "gate_evidence_missing" });
  });

  it("dynamic continue without sandbox_alloc: dead", async () => {
    m.taskById = preparingTask({ source_meta: { dynamic_enabled: true } });
    writeEvidence(hostWorkDir);
    writeGate(hostWorkDir, "next: continue\nreason: complete\nsandbox_type: linux-docker\n");
    await fireRoute("cycle_join");
    expect(m.failClaimCalls).toBe(1);
    expect(m.events.find((e) => e.type === "prepare_failed")).toMatchObject({ reason: "gate_evidence_missing" });
  });

  it("dynamic continue with alloc recorded: passes", async () => {
    m.taskById = preparingTask({ source_meta: { dynamic_enabled: true }, metadata: { sandbox_alloc: { sandbox_id: "sb-1" } } });
    writeEvidence(hostWorkDir);
    writeGate(hostWorkDir, "next: continue\nreason: complete\nsandbox_type: linux-docker\n");
    await fireRoute("cycle_join");
    expect(m.markedRunningCalls).toBe(1);
  });

  it.each([
    ["partial_source", "源码不完整", true],
    ["fragment_collection", "片段集", true],
    ["no_compatible_sandbox", "沙箱", false],
    ["sandbox_unavailable", "沙箱", false],
  ])("end with reason %s: prepare_failed + claim failed%s", async (reason, _kw, incomplete) => {
    writeGate(hostWorkDir, `next: end\nreason: ${reason}\ndetail: 一句人话\n`);
    await fireRoute("exit");
    expect(m.failClaimCalls).toBe(1);
    const failed = m.events.find((e) => e.type === "prepare_failed");
    expect(failed).toBeTruthy();
    const patch = m.metadataPatches.find((p) => "source_incomplete" in p);
    if (incomplete) expect(patch).toEqual({ source_incomplete: true });
    else expect(patch).toBeUndefined();
  });

  it("bad gate.yaml on end: tolerated, generic reason", async () => {
    writeGate(hostWorkDir, "not: valid: gate: shape\n");
    await fireRoute("exit");
    expect(m.failClaimCalls).toBe(1);
  });

  it("non-preparing task: idempotent no-op", async () => {
    m.taskById = preparingTask({ state: "running" });
    await fireRoute("cycle_join");
    expect(m.markedRunningCalls).toBe(0);
    expect(m.failClaimCalls).toBe(0);
  });

  it("lost claim: no-op (reconciler owns)", async () => {
    m.claim = null;
    await fireRoute("cycle_join");
    expect(m.markedRunningCalls).toBe(0);
  });

  it("die during preparing without gate.yaml: human failReason + init_aborted event", async () => {
    // QA 6766220b: reasoning model burned its output budget mid-thinking,
    // flow died with no gate.yaml — user must see human language, not a
    // bare exit code (fish 2026-08-19, task ③).
    m.taskById = preparingTask({
      metadata: { _scan_scheduler_claim: { token, mode: "fresh" } },
    });
    const { TaskScheduler: TS } = await import("../../src/features/workers/scheduler.js");
    const sched = new TS({ dataDir: "/tmp/gate-test", minio: { bucket: "b" } } as any);
    // No gate.yaml in hostWorkDir (fixture never wrote one) → falls to the
    // init-aborted branch.
    await (sched as any).handleDieDuringPreparing("task-gate-1", token, 1, hostWorkDir);
    expect(m.failClaimCalls).toBe(1);
    const failArg = (globalThis as any).__lastFailReason ?? "";
    void failArg;
    // grab fail reason from the mocked storage call
    const storage = await import("../../src/features/tasks/storage.js");
    const failCall = (storage.failSchedulerClaim as any).mock.calls.at(-1);
    expect(failCall?.[2]).toContain("初始化未完成");
    expect(failCall?.[2]).toContain("退出码 1");
    const failed = m.events.find((e) => e.type === "prepare_failed");
    expect(failed).toMatchObject({ reason: "init_aborted" });
    expect(failed.remediation).toContain("初始化未完成");
  });
});
