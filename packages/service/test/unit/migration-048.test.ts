import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../src/infra/db/migrations/048_api_token_status.sql", import.meta.url),
  "utf8",
);

describe("migration 048 contract (api token status lifecycle)", () => {
  it("adds status column with active default (existing rows stay valid)", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'/);
  });

  it("constrains status to the two lifecycle values", () => {
    expect(migration).toMatch(/CHECK \(status IN \('active', 'disabled'\)\)/);
  });

  it("is additive and idempotent (no destructive statements)", () => {
    expect(migration).not.toMatch(/DROP\s+COLUMN/i);
    expect(migration).toMatch(/DROP CONSTRAINT IF EXISTS/);
  });
});
