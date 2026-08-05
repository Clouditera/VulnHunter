import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  containers: [] as any[], preparing: [] as any[], tasks: new Map<string, any>(),
  mark: vi.fn(async () => true), release: vi.fn(async () => true), stop: vi.fn(async () => undefined), cleanup: vi.fn(async () => undefined), tail: vi.fn(), remove: vi.fn(),
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
}));
vi.mock("../../src/features/workers/scan-worker.js", () => ({
  getHostWorkDir: (dataDir: string, taskId: string) => `${dataDir}/workspaces/${taskId}`, stopScanWorkerByClaim: m.stop,
}));
vi.mock("../../src/features/workers/scheduler-workspace.js", () => ({ cleanupSchedulerWorkspace: m.cleanup }));
vi.mock("../../src/features/events/event-tail.js", () => ({ startTailing: m.tail }));
vi.mock("../../src/infra/config.js", () => ({ loadConfig: () => ({ dataDir: "/data" }) }));
vi.mock("../../src/infra/db/client.js", () => ({ getDb: vi.fn() }));

import { reconcileSchedulerClaims } from "../../src/features/workers/reconciler.js";

const token = "11111111-1111-4111-8111-111111111111";
const labels = { "vulnhunter.task_id": "task-1", "vulnhunter.task_type": "scan", "vulnhunter.scheduler_claim": token };
const claim = { token, lease_expires_at: new Date(Date.now() + 90000).toISOString(), deadline_at: new Date(Date.now() + 900000).toISOString() };

describe("scheduler claim reconciler", () => {
  beforeEach(() => { vi.clearAllMocks(); m.containers = []; m.preparing = []; m.tasks.clear(); m.mark.mockResolvedValue(true); m.release.mockResolvedValue(true); });

  it("adopts a running Worker with the matching preparing claim", async () => {
    m.preparing = [{ id: "task-1", scheduler_claim: claim }];
    m.containers = [{ Id: "c1", State: "running", Labels: labels }];
    m.tasks.set("task-1", { id: "task-1", state: "preparing", metadata: { _scan_scheduler_claim: claim } });
    await reconcileSchedulerClaims({ dataDir: "/data" } as any);
    expect(m.mark).toHaveBeenCalledWith("task-1", token, expect.any(Date));
    expect(m.tail).toHaveBeenCalledTimes(1);
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
