import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../src/infra/db/migrations/035_sandbox_ssh_internal_and_host_key.sql", import.meta.url),
  "utf8",
);

describe("migration 035 contract (ssh_internal_host + ssh_host_public_key)", () => {
  it("adds nullable columns for plane v0.3.2 bastion/pin fields", () => {
    expect(migration).toContain("ALTER TABLE task_sandboxes");
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS ssh_internal_host TEXT/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS ssh_host_public_key TEXT/);
  });

  it("stays additive (no DROP / NOT NULL force)", () => {
    expect(migration).not.toMatch(/\bDROP\b/i);
    expect(migration).not.toMatch(/NOT NULL/);
  });
});
