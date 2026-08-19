import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  containers: [] as any[], preparing: [] as any[], tasks: new Map<string, any>(),
  mark: vi.fn(async () => true), release: vi.fn(async () => true), stop: vi.fn(async () => undefined), cleanup: vi.fn(async () => undefined), tail: vi.fn(), remove: vi.fn(),
  fail: vi.fn(async () => true), merge: vi.fn(async () => undefined), setHandler: vi.fn(),
  armed: new Set<string>(),
  gateYaml: null as string | null, checkpointYaml: null as string | null, hostWorkDirByTask: new Map<string, string>(),
}));
vi.mock("../../src/features/workers/docker-client.js", () => ({
  LABEL_TASK_ID: "vulnhunter.task_id", LABEL_TASK_TYPE: "vulnhunter.task_type", LABEL_SCHEDULER_CLAIM: "vulnhunter.scheduler_claim",
  listManagedContainers: vi.fn(async () => m.containers),
  getDocker: () => ({ getContainer: () => ({ remove: m.remove, stop: vi.fn() }) }),
  removeWorkDir: vi.fn(async () => undefined),
}));
vi.mock("../../src/features/tasks/storage.js", () => ({
  listPreparingSchedulerClaims: vi.fn(async () => m.preparing), markSchedulerClaimRunning: m.mark,
  releaseExpiredSchedulerClaim: m.release, getTaskById: vi.fn(async (id: string) => m.tasks.get(id) ?? null),
  getSchedulerClaim: vi.fn((task: any) => task.metadata?._scan_scheduler_claim ?? null), updateTaskState: vi.fn(),
  failSchedulerClaim: m.fail, mergeTaskMetadata: m.merge,
}));
vi.mock("../../src/features/workers/scan-worker.js", () => ({
  getHostWorkDir: (dataDir: string, taskId: string) => m.hostWorkDirByTask.get(taskId) ?? `${dataDir}/workspaces/${taskId}`, stopScanWorkerByClaim: m.stop,
}));
vi.mock("../../src/features/workers/scheduler-workspace.js", () => ({ cleanupSchedulerWorkspace: m.cleanup }));
vi.mock("../../src/features/events/event-tail.js", () => ({
  startTailing: m.tail,
  setEngineEventHandler: m.setHandler,
  hasEngineEventHandler: (taskId: string) => m.armed.has(taskId),
}));
vi.mock("../../src/features/events/event-store.js", () => ({ appendEvent: vi.fn((_t: string, e: any) => ({ seq: 1, event: e })) }));
vi.mock("../../src/features/events/ws-live-log.js", () => ({ broadcastEvent: vi.fn() }));
vi.mock("../../src/notifications/index.js", () => ({ notify: vi.fn() }));
vi.mock("../../src/infra/config.js", () => ({ loadConfig: () => ({ dataDir: "/data" }) }));
vi.mock("../../src/infra/db/client.js", () => ({ getDb: vi.fn() }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (p: string) => {
      if (p.endsWith("gate.yaml")) return m.gateYaml !== null;
      if (p.includes("knowledge/") && (p.endsWith(".yaml") || p.endsWith(".md"))) return true; // evidence present
      return actual.existsSync(p);
    },
    readFileSync: (p: string, ...rest: unknown[]) => {
      if (p.endsWith("flow_state.yaml")) return m.checkpointYaml ?? "";
      if (p.endsWith("gate.yaml")) return m.gateYaml ?? "";
      return (actual.readFileSync as any)(p, ...rest);
    },
    statSync: (p: string) => ({ size: (m.gateYaml ?? "").length + 100 }),
  };
});

import { reconcileSchedulerClaims } from "../../src/features/workers/reconciler.js";

const token = "11111111-1111-4111-8111-111111111111";
const labels = { "vulnhunter.task_id": "task-1", "vulnhunter.task_type": "scan", "vulnhunter.scheduler_claim": token };
const claim = { token, lease_expires_at: new Date(Date.now() + 90000).toISOString(), deadline_at: new Date(Date.now() + 900000).toISOString() };

describe("scheduler claim reconciler", () => {
  beforeEach(() => { vi.clearAllMocks(); m.containers = []; m.preparing = []; m.tasks.clear(); m.armed.clear(); m.mark.mockResolvedValue(true); m.release.mockResolvedValue(true); });
  // Mirror the real handler map semantics: set(null) disarms, set(fn) arms.
  m.setHandler.mockImplementation((taskId: string, handler: unknown) => {
    if (handler === null) m.armed.delete(taskId);
    else m.armed.add(taskId);
  });

  it("adopts a running Worker with the matching preparing claim", async () => {
    m.preparing = [{ id: "task-1", scheduler_claim: claim }];
    m.containers = [{ Id: "c1", State: "running", Labels: labels }];
    m.tasks.set("task-1", { id: "task-1", state: "preparing", metadata: { _scan_scheduler_claim: claim } });
    await reconcileSchedulerClaims({ dataDir: "/data" } as any);
    expect(m.mark).toHaveBeenCalledWith("task-1", token, expect.any(Date));
    expect(m.tail).toHaveBeenCalledTimes(1);
    // Tail ONLY the live .service-logs copy — the out/.youngflow/logs copy is
    // finalize-time only; tailing both replays every event (QA fbc08f1b).
    const paths = m.tail.mock.calls[0][2].map((r: { path: string }) => r.path);
    expect(paths).toEqual(["/data/workspaces/task-1/.service-logs"]);
    expect(m.stop).not.toHaveBeenCalled();
  });

  it("requeues and cleans only an expired token with no running Worker", async () => {
    const expired = { ...claim, lease_expires_at: new Date(Date.now() - 1000).toISOString() };
    m.preparing = [{ id: "task-1", scheduler_claim: expired }];
    m.tasks.set("task-1", { id: "task-1", state: "preparing", metadata: { _scan_scheduler_claim: expired } });
    await reconcileSchedulerClaims({ dataDir: "/data" } as any);
    expect(m.release).toHaveBeenCalledWith("task-1", token);
    expect(m.stop).toHaveBeenCalledWith("task-1", token);
    expect(m.cleanup).toHaveBeenCalledWith("/data/workspaces/task-1", token);
  });

  it("does not release a claim on deadline_at alone within the H3 stuck margin", async () => {
    // deadline_at passed but lease still live and within the +720s margin:
    // the adopted worker may be running its own bounded finalizer, so the
    // reconciler must not force-stop it (form B is forbidden).
    const recentDeadline = {
      ...claim,
      lease_expires_at: new Date(Date.now() + 90000).toISOString(),
      deadline_at: new Date(Date.now() - 1000).toISOString(), // 1s past, well within 720s margin
    };
    m.preparing = [{ id: "task-1", scheduler_claim: recentDeadline }];
    m.tasks.set("task-1", { id: "task-1", state: "preparing", metadata: { _scan_scheduler_claim: recentDeadline } });
    await reconcileSchedulerClaims({ dataDir: "/data" } as any);
    expect(m.release).not.toHaveBeenCalled();
    expect(m.stop).not.toHaveBeenCalled();
  });

  describe("fresh gate-phase restart paths (engine-native gate)", () => {
    const freshClaim = { ...claim, mode: "fresh" };
    const freshTask = {
      id: "task-1", state: "preparing", source_meta: {}, started_at: null,
      metadata: { _scan_scheduler_claim: freshClaim },
      scheduler_claim: freshClaim,
    };
    const runningCtr = [{ Id: "c1", State: "running", Labels: labels, Names: ["vh-scan-task-1"] }];

    beforeEach(() => { m.gateYaml = null; m.checkpointYaml = null; });

    it("gate not yet routed: re-arms tailing + route handler (no wedge after restart)", async () => {
      m.preparing = [freshTask]; m.containers = runningCtr;
      m.checkpointYaml = null; // checkpoint absent/unreadable
      await reconcileSchedulerClaims({ dataDir: "/data" } as any);
      expect(m.tail).toHaveBeenCalled();                    // perception channel re-attached
      expect(m.setHandler).toHaveBeenCalledWith("task-1", expect.any(Function)); // handler re-armed
      expect(m.mark).not.toHaveBeenCalled();               // stays preparing
    });

    it("re-arm is once-only: consecutive reconciles start tailing exactly once (no log replay)", async () => {
      m.preparing = [freshTask]; m.containers = runningCtr;
      m.checkpointYaml = null; // gate not routed → re-arm branch
      await reconcileSchedulerClaims({ dataDir: "/data" } as any);
      expect(m.tail).toHaveBeenCalledTimes(1);
      expect(m.setHandler).toHaveBeenCalledTimes(1);
      // Second tick (handler armed by the first pass): no re-tail, no re-arm —
      // otherwise every tick replays the whole engine log into the timeline
      // (QA f14c6582 regression).
      await reconcileSchedulerClaims({ dataDir: "/data" } as any);
      expect(m.tail).toHaveBeenCalledTimes(1);
      expect(m.setHandler).toHaveBeenCalledTimes(1);
    });

    it("checkpoint continue + evidence: adopts and carries gate sandbox_type into metadata.prepare", async () => {
      m.preparing = [freshTask]; m.containers = runningCtr;
      m.checkpointYaml = "extracted:\n  onboard:\n    next: continue\n";
      m.gateYaml = "next: continue\nreason: complete\nsandbox_type: linux-docker\n";
      await reconcileSchedulerClaims({ dataDir: "/data" } as any);
      expect(m.mark).toHaveBeenCalledWith("task-1", token, expect.any(Date));
      const patch = m.merge.mock.calls.find((c: any[]) => c[1]?.prepare)?.[1];
      expect(patch.prepare.sandbox_type).toBe("linux-docker"); // not hardcoded null
    });

    it("checkpoint end: prepare_failed event + source_incomplete + fail claim", async () => {
      m.preparing = [freshTask]; m.containers = runningCtr;
      m.checkpointYaml = "extracted:\n  onboard:\n    next: end\n";
      m.gateYaml = "next: end\nreason: partial_source\ndetail: 缺核心模块\nsandbox_type: null\n";
      const { appendEvent } = await import("../../src/features/events/event-store.js");
      await reconcileSchedulerClaims({ dataDir: "/data" } as any);
      expect(m.fail).toHaveBeenCalled();
      expect(m.merge).toHaveBeenCalledWith("task-1", { source_incomplete: true });
      const event = (appendEvent as any).mock.calls.at(-1)?.[1];
      expect(event).toMatchObject({ type: "prepare_failed", reason: "source_incomplete", detail: "缺核心模块" });
    });
  });

  it("releases a claim whose deadline_at is past the H3 stuck margin", async () => {
    const stuckDeadline = {
      ...claim,
      lease_expires_at: new Date(Date.now() + 90000).toISOString(),
      deadline_at: new Date(Date.now() - 800 * 1000).toISOString(), // 800s past > 720s margin
    };
    m.preparing = [{ id: "task-1", scheduler_claim: stuckDeadline }];
    m.tasks.set("task-1", { id: "task-1", state: "preparing", metadata: { _scan_scheduler_claim: stuckDeadline } });
    await reconcileSchedulerClaims({ dataDir: "/data" } as any);
    expect(m.release).toHaveBeenCalledWith("task-1", token);
    expect(m.stop).toHaveBeenCalledWith("task-1", token);
  });

  it("removes a terminal task's running Worker by exact token", async () => {
    m.containers = [{ Id: "c1", State: "running", Labels: labels }];
    m.tasks.set("task-1", { id: "task-1", state: "failed", metadata: {} });
    await reconcileSchedulerClaims({ dataDir: "/data" } as any);
    expect(m.stop).toHaveBeenCalledWith("task-1", token);
  });
});
