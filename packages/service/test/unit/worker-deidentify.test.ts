import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * Worker de-identification (task-78043fc0, fish-approved 2026-08-05):
 * containers spawn as the service uid, HOME repointed into the workspace,
 * .home pre-created host-side when visible.
 */

const createContainer = vi.fn(async (_spec: unknown) => ({ id: "cid" }));

vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/features/workers/instance-id.js", () => ({
  getWorkerInstanceId: () => "test-instance",
}));

const { initDocker, createWorkerContainer } = await import("../../src/features/workers/docker-client.js");

initDocker("/nonexistent.sock"); // dockerode never dials until a call; createContainer is mocked below

// getDocker() returns the real Dockerode instance from initDocker — patch its
// createContainer so no daemon is needed.
import { getDocker } from "../../src/features/workers/docker-client.js";
(getDocker() as unknown as { createContainer: typeof createContainer }).createContainer = createContainer;

const base = {
  taskId: "11111111-1111-4111-8111-111111111111",
  image: "vulnhunter-worker:test",
  env: { MODE: "scan" },
} as const;

describe("worker de-identification (task-78043fc0)", () => {
  it("spawns as the service uid:gid and injects HOME into the workspace", async () => {
    createContainer.mockClear();
    const dir = mkdtempSync(join(tmpdir(), "worker-deid-"));
    await createWorkerContainer({ ...base, taskType: "scan", hostWorkDir: dir });

    const spec = createContainer.mock.calls[0]![0] as { User: string; Env: string[] };
    expect(spec.User).toBe(`${process.getuid()}:${process.getgid()}`);
    expect(spec.Env).toContain("HOME=/workspace/.home");
    expect(existsSync(join(dir, ".home"))).toBe(true);
  });

  it("runAs override wins; caller-provided HOME is not clobbered", async () => {
    createContainer.mockClear();
    const dir = mkdtempSync(join(tmpdir(), "worker-deid-"));
    await createWorkerContainer({
      ...base, taskType: "scan", hostWorkDir: dir, runAs: "0:0",
      env: { MODE: "scan", HOME: "/custom" },
    });
    const spec = createContainer.mock.calls[0]![0] as { User: string; Env: string[] };
    expect(spec.User).toBe("0:0");
    expect(spec.Env).toContain("HOME=/custom");
    expect(spec.Env).not.toContain("HOME=/workspace/.home");
  });

  it("no workspace mount -> no HOME injection (no writable target)", async () => {
    createContainer.mockClear();
    await createWorkerContainer({ ...base, taskType: "diagnostic" });
    const spec = createContainer.mock.calls[0]![0] as { Env: string[] };
    expect(spec.Env.some((e) => e.startsWith("HOME="))).toBe(false);
  });
});
