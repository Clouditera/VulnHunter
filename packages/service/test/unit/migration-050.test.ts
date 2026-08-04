import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../src/infra/db/migrations/050_task_completion_reason.sql", import.meta.url),
  "utf8",
);

describe("migration 050 contract (tasks.completion_reason)", () => {
  it("adds completion_reason with natural default (existing rows stay natural)", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS completion_reason TEXT NOT NULL DEFAULT 'natural'/);
  });

  it("constrains values to natural|timeout", () => {
    expect(migration).toMatch(/CHECK \(completion_reason IN \('natural', 'timeout'\)\)/);
  });

  it("is additive and idempotent (no destructive statements)", () => {
    expect(migration).not.toMatch(/DROP\s+COLUMN/i);
    expect(migration).toMatch(/DROP CONSTRAINT IF EXISTS/);
  });
});
