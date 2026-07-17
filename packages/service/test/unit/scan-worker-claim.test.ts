import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const start = vi.fn();
  const inspect = vi.fn();
  const remove = vi.fn();
  const listContainers = vi.fn(async () => [] as any[]);
  return {
    start, inspect, remove, listContainers,
    createWorkerContainer: vi.fn(async () => ({ id: "container-1", start })),
    getContainer: vi.fn(() => ({ inspect, remove, stop: vi.fn() })),
  };
});
const { start, inspect, remove, listContainers, createWorkerContainer, getContainer } = mocks;

vi.mock("../../src/features/workers/docker-client.js", () => ({
  LABEL_TASK_ID: "vulnagent.task_id",
  LABEL_TASK_TYPE: "vulnagent.task_type",
  LABEL_SCHEDULER_CLAIM: "vulnagent.scheduler_claim",
  createWorkerContainer: mocks.createWorkerContainer,
  ensureWorkDir: vi.fn(),
  removeWorkDir: vi.fn(),
  getDocker: () => ({ getContainer: mocks.getContainer, listContainers: mocks.listContainers }),
}));

vi.mock("../../src/features/tasks/storage.js", () => ({
  mergeTaskMetadata: vi.fn(async () => undefined),
}));

vi.mock("../../src/features/workers/audit-completion.js", () => ({
  createAuditCompletionEngineRun: vi.fn((id: string, at: string) => ({ run_id: id, started_at: at })),
  fingerprintAuditCompletion: vi.fn(() => null),
}));

import { spawnScanWorker, stopScanWorkerByClaim } from "../../src/features/workers/scan-worker.js";

const task = {
  id: "task-1", source_meta: {}, started_at: null,
} as any;
const config = {
  dataDir: "/tmp/data",
  docker: { workerImage: "worker:test", network: "internal", workerServiceUrl: "http://service" },
  minio: { endpoint: "minio", port: 9000, accessKey: "a", secretKey: "b", bucket: "bucket" },
} as any;
const token = "11111111-1111-4111-8111-111111111111";

describe("claim-owned scan worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inspect.mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
  });

  it("creates and starts once with the scheduler claim label", async () => {
    await expect(spawnScanWorker(task, config, {}, token)).resolves.toBe("container-1");
    expect(createWorkerContainer).toHaveBeenCalledTimes(1);
    expect(createWorkerContainer.mock.calls[0][0]).toMatchObject({ labels: { "vulnagent.scheduler_claim": token } });
    expect(start).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it("fails closed instead of force-removing a same-name live worker", async () => {
    inspect.mockResolvedValue({ State: { Status: "running" }, Config: { Labels: { "vulnagent.scheduler_claim": "other" } } });
    await expect(spawnScanWorker(task, config, {}, token)).rejects.toThrow("name conflict");
    expect(createWorkerContainer).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("filters cleanup by task and exact claim token", async () => {
    await stopScanWorkerByClaim("task-1", token);
    const filters = JSON.parse(listContainers.mock.calls[0][0].filters);
    expect(filters.label).toEqual([
      "vulnagent.task_id=task-1",
      "vulnagent.task_type=scan",
      `vulnagent.scheduler_claim=${token}`,
    ]);
  });
});
