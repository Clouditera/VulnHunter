import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * scheduler-workspace cleanup must route workspace-content removals through
 * removeWorkDir (Docker root fallback) — bare rm dies EACCES on container
 * root-written files and wedges 继续扫描 (31.106 TripStar, task-6312298a).
 */

const removeWorkDir = vi.fn(async (_path: string, _image?: string) => undefined);

vi.mock("../../src/features/workers/docker-client.js", () => ({
  removeWorkDir,
}));

const {
  cleanupSchedulerWorkspace,
  publishSchedulerWorkspace,
  getSchedulerBackupDir,
  getSchedulerPrepareDir,
} = await import("../../src/features/workers/scheduler-workspace.js");

const TOKEN = "11111111-1111-4111-8111-111111111111";

let hostWorkDir: string;

beforeEach(() => {
  removeWorkDir.mockClear();
  hostWorkDir = mkdtempSync(join(tmpdir(), "sched-ws-"));
});

describe("scheduler workspace removal fallback (task-6312298a)", () => {
  it("cleanup: existing canonical + stale backup -> backup removed via removeWorkDir", async () => {
    mkdirSync(join(hostWorkDir, "src"), { recursive: true });
    const backup = getSchedulerBackupDir(hostWorkDir, TOKEN);
    mkdirSync(join(backup, "__pycache__"), { recursive: true }); // root-written in the field
    writeFileSync(join(backup, "__pycache__", "x.pyc"), "root-owned");

    await cleanupSchedulerWorkspace(hostWorkDir, TOKEN);

    expect(removeWorkDir.mock.calls.some((c) => c[0] === backup)).toBe(true);
    expect(existsSync(join(hostWorkDir, "src"))).toBe(true); // canonical untouched
  });

  it("cleanup: backup restored when canonical missing (rename path, no removal)", async () => {
    const backup = getSchedulerBackupDir(hostWorkDir, TOKEN);
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, "keep.txt"), "data");

    await cleanupSchedulerWorkspace(hostWorkDir, TOKEN);

    expect(existsSync(join(hostWorkDir, "src", "keep.txt"))).toBe(true);
    expect(existsSync(backup)).toBe(false);
    expect(removeWorkDir.mock.calls.some((c) => c[0] === backup)).toBe(false);
  });

  it("publish: staged source wins, old canonical backup removed via removeWorkDir", async () => {
    mkdirSync(join(hostWorkDir, "src"), { recursive: true });
    writeFileSync(join(hostWorkDir, "src", "old.txt"), "old");
    const stage = getSchedulerPrepareDir(hostWorkDir, TOKEN);
    mkdirSync(join(stage, "src"), { recursive: true });
    writeFileSync(join(stage, "src", "new.txt"), "new");

    await publishSchedulerWorkspace(hostWorkDir, TOKEN);

    expect(existsSync(join(hostWorkDir, "src", "new.txt"))).toBe(true);
    expect(existsSync(join(hostWorkDir, "src", "old.txt"))).toBe(false);
    const backup = getSchedulerBackupDir(hostWorkDir, TOKEN);
    expect(removeWorkDir.mock.calls.some((c) => c[0] === backup)).toBe(true);
  });

  it("publish: failure rolls back canonical from backup (rename path preserved)", async () => {
    mkdirSync(join(hostWorkDir, "src"), { recursive: true });
    writeFileSync(join(hostWorkDir, "src", "old.txt"), "old");
    // no staged source -> throws before any rename; backup untouched
    await expect(publishSchedulerWorkspace(hostWorkDir, TOKEN)).rejects.toThrow("staging source is missing");
    expect(existsSync(join(hostWorkDir, "src", "old.txt"))).toBe(true);
  });

  it("cleanup image comes from WORKER_IMAGE env (never bare :latest assumption)", async () => {
    process.env.WORKER_IMAGE = "vulnhunter-worker:2.3.4";
    try {
      mkdirSync(join(hostWorkDir, "src"), { recursive: true });
      const backup = getSchedulerBackupDir(hostWorkDir, TOKEN);
      mkdirSync(backup, { recursive: true });
      await cleanupSchedulerWorkspace(hostWorkDir, TOKEN);
      expect(removeWorkDir).toHaveBeenCalledWith(backup, "vulnhunter-worker:2.3.4");
    } finally {
      delete process.env.WORKER_IMAGE;
    }
  });
});
