import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../src/infra/db/migrations/028_task_sandboxes.sql", import.meta.url),
  "utf8",
);

describe("migration 028 contract (task_sandboxes + user sandbox quota)", () => {
  it("creates the 1:1 mapping keyed by task_id with deterministic request_id uniqueness", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS task_sandboxes");
    expect(migration).toMatch(/task_id\s+UUID PRIMARY KEY/);
    expect(migration).toContain("task_sandboxes_request_id_idx");
    // No FK to tasks by design — the delete flow + reconciler own release
    // ordering, and a crashed delete must not wedge the mapping row.
    expect(migration).not.toMatch(/REFERENCES\s+tasks/i);
  });

  it("locks the docker-style lifecycle state machine (no lease states)", () => {
    expect(migration).toContain("task_sandboxes_state_check");
    for (const state of ["creating", "ready", "stopped", "releasing", "released", "failed"]) {
      expect(migration).toContain(`'${state}'`);
    }
    expect(migration).not.toMatch(/lease_|_lease/);
  });

  it("keeps ssh coordinates and resource snapshots nullable; host_key NULL until #7", () => {
    for (const col of ["ssh_host", "ssh_port", "ssh_user", "host_key", "cpu_cores", "memory_mb", "failure_reason"]) {
      expect(migration).toContain(col);
    }
    expect(migration).not.toMatch(/host_key\s+TEXT\s+NOT NULL/);
  });

  it("adds the three per-user quota columns with 0=unlimited defaults", () => {
    for (const col of ["sandbox_max_running", "sandbox_max_cpu_cores", "sandbox_max_memory_gb"]) {
      expect(migration).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col} INTEGER NOT NULL DEFAULT 0`));
    }
  });

  it("stays idempotent and additive (no backfill/destructive statements)", () => {
    expect(migration).not.toMatch(/\bUPDATE\s+users\b|\bUPDATE\s+tasks\b/i);
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(migration).toContain("EXCEPTION WHEN duplicate_object THEN NULL");
    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
  });
});
