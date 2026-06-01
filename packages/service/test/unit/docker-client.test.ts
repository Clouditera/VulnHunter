import { beforeEach, describe, expect, it, vi } from "vitest";

const createContainer = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(() => {
    throw new Error("EACCES");
  }),
}));

vi.mock("dockerode", () => ({
  default: vi.fn(() => ({ createContainer })),
}));

const { initDocker, removeWorkDir } = await import("../../src/features/workers/docker-client.js");

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
