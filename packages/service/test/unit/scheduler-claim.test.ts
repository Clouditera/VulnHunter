import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSchedulerClaim, schedulerClaimMode, type DbTask } from "../../src/features/tasks/storage.js";
import { cleanupSchedulerWorkspace, getSchedulerBackupDir, getSchedulerPrepareDir, publishSchedulerWorkspace } from "../../src/features/workers/scheduler-workspace.js";

const token = "11111111-1111-4111-8111-111111111111";
const validClaim = {
  version: 1,
  token,
  owner_instance: "22222222-2222-4222-8222-222222222222",
  claimed_at: "2026-07-15T00:00:00.000Z",
  lease_expires_at: "2026-07-15T00:01:30.000Z",
  deadline_at: "2026-07-15T00:15:00.000Z",
  mode: "fresh",
};

function task(overrides: Partial<DbTask> = {}): DbTask {
  return {
    id: "task-1", tenant_id: "tenant", created_by: "user", project_name: "p", display_name: null,
    state: "preparing", source_type: "upload", source_meta: {}, risk_score: null, failure_reason: null,
    total_tokens_in: 0, total_tokens_out: 0, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, tool_call_count: 0, stage_count: 0,
    auto_skill_ids: [], created_at: new Date(), started_at: null, completed_at: null, duration_ms: null,
    findings_indexed_at: null, metadata: { _scan_scheduler_claim: validClaim }, credential_id: null,
    ...overrides,
  };
}

describe("scheduler claim contract", () => {
  it("strictly parses a valid v1 claim and rejects malformed claims", () => {
    expect(getSchedulerClaim(task())).toEqual(validClaim);
    expect(getSchedulerClaim(task({ metadata: JSON.stringify({ _scan_scheduler_claim: validClaim }) as unknown as Record<string, unknown> }))).toEqual(validClaim);
    for (const claim of [null, {}, { ...validClaim, version: 2 }, { ...validClaim, token: "bad" }, { ...validClaim, lease_expires_at: "bad" }, { ...validClaim, mode: "other" }]) {
      expect(getSchedulerClaim(task({ metadata: { _scan_scheduler_claim: claim } }))).toBeNull();
    }
  });

  it("derives fresh/resume/continue claim modes deterministically", () => {
    expect(schedulerClaimMode(task({ state: "queued" }))).toBe("fresh");
    expect(schedulerClaimMode(task({ state: "queued", started_at: new Date() }))).toBe("resume");
    expect(schedulerClaimMode(task({ state: "queued", source_meta: { continue_mode: true }, started_at: null }))).toBe("continue");
  });

  it("uses token-private staging and atomically replaces canonical source", async () => {
    const root = mkdtempSync(join(tmpdir(), "scheduler-claim-workspace-"));
    try {
      const stage = getSchedulerPrepareDir(root, token);
      mkdirSync(join(stage, "src"), { recursive: true });
      writeFileSync(join(stage, "src", "new.txt"), "new");
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "old.txt"), "old");

      await publishSchedulerWorkspace(root, token);

      expect(readFileSync(join(root, "src", "new.txt"), "utf8")).toBe("new");
      expect(readdirSync(root).filter((name) => name.includes(token))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores a canonical source after a crash between backup and publish", async () => {
    const root = mkdtempSync(join(tmpdir(), "scheduler-claim-recover-"));
    try {
      const backup = getSchedulerBackupDir(root, token);
      mkdirSync(backup, { recursive: true });
      writeFileSync(join(backup, "old.txt"), "old");
      mkdirSync(getSchedulerPrepareDir(root, token), { recursive: true });
      await cleanupSchedulerWorkspace(root, token);
      expect(readFileSync(join(root, "src", "old.txt"), "utf8")).toBe("old");
      expect(readdirSync(root).filter((name) => name.includes(token))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects non-UUID tokens before constructing paths", () => {
    expect(() => getSchedulerPrepareDir("/tmp/work", "../../escape")).toThrow();
  });
});
