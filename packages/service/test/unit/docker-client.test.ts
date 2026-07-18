import { beforeEach, describe, expect, it, vi } from "vitest";

const createContainer = vi.fn();
const listContainers = vi.fn(async () => []);
const getEvents = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(() => {
    throw new Error("EACCES");
  }),
}));

vi.mock("dockerode", () => ({
  default: vi.fn(() => ({ createContainer, listContainers, getEvents })),
}));

vi.mock("../../src/features/workers/instance-id.js", () => ({
  getWorkerInstanceId: vi.fn(() => "test-instance-id"),
}));

const { initDocker, removeWorkDir, createWorkerContainer, listManagedContainers, subscribeToDockerEvents } =
  await import("../../src/features/workers/docker-client.js");

describe("removeWorkDir", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createContainer.mockResolvedValue({
      attach: vi.fn(async () => ({ on: vi.fn() })),
      start: vi.fn(async () => undefined),
      wait: vi.fn(async () => ({ StatusCode: 0 })),
      remove: vi.fn(async () => undefined),
    });
    initDocker();
  });

  it("uses the configured cleanup image for Docker fallback", async () => {
    await removeWorkDir("/data/workspaces/task-1", "vulnagent-worker:1.0.3");

    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ Image: "vulnagent-worker:1.0.3" }),
    );
  });
});

describe("worker instance scoping (2026-07-18 near-miss fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createContainer.mockResolvedValue({ id: "c1" });
    listContainers.mockResolvedValue([]);
    getEvents.mockImplementation((_opts: unknown, cb: (err: unknown, stream: unknown) => void) => {
      cb(null, { on: vi.fn(), destroy: vi.fn() });
    });
    initDocker();
  });

  it("labels every created worker container with this install's instance id", async () => {
    await createWorkerContainer({
      taskId: "task-1",
      taskType: "scan",
      image: "vulnagent-worker:latest",
      env: {},
    });

    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Labels: expect.objectContaining({
          "vulnagent.managed": "true",
          "vulnagent.instance": "test-instance-id",
        }),
      }),
    );
  });

  it("scopes listManagedContainers to this instance's label (sibling installs invisible)", async () => {
    await listManagedContainers();

    const call = listContainers.mock.calls[0][0] as { filters: string };
    const filters = JSON.parse(call.filters);
    expect(filters.label).toEqual(["vulnagent.managed=true", "vulnagent.instance=test-instance-id"]);
  });

  it("scopes the docker event subscription to this instance's label", () => {
    const unsubscribe = subscribeToDockerEvents(() => {});
    const call = getEvents.mock.calls[0][0] as { filters: string };
    const filters = JSON.parse(call.filters);
    expect(filters.label).toEqual(["vulnagent.managed=true", "vulnagent.instance=test-instance-id"]);
    unsubscribe();
  });
});
