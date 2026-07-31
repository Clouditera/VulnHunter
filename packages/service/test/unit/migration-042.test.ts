import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../src/infra/db/migrations/042_user_api_tokens.sql", import.meta.url),
  "utf8",
);

describe("migration 042 contract (user_api_tokens)", () => {
  it("creates user_api_tokens with the contract columns", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS user_api_tokens/);
    for (const col of [
      "id",
      "tenant_id",
      "user_id",
      "name",
      "token_hash",
      "created_at",
      "last_used_at",
      "revoked_at",
    ]) {
      expect(migration).toContain(col);
    }
  });

  it("stores only a unique token hash, never plaintext", () => {
    expect(migration).toMatch(/token_hash\s+TEXT\s+NOT NULL\s+UNIQUE/);
    // No plaintext token column.
    expect(migration).not.toMatch(/\btoken\s+TEXT\b/);
  });

  it("cascades on user delete", () => {
    expect(migration).toMatch(/user_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  });

  it("has NO expiry column (revocation-only invalidation)", () => {
    expect(migration).not.toMatch(/expires_at/);
  });

  it("adds a partial hash index over live (non-revoked) tokens for the hot path", () => {
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS idx_user_api_tokens_hash/);
    expect(migration).toMatch(/ON user_api_tokens\(token_hash\)\s*\n?\s*WHERE revoked_at IS NULL/);
  });

  it("stays additive and idempotent (no destructive statements)", () => {
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });
});
