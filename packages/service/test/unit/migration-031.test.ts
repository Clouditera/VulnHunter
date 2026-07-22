import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("migration 031 email registration", () => {
  const sql = readFileSync(
    resolve(__dirname, "../../src/infra/db/migrations/031_email_registration.sql"),
    "utf8",
  );

  it("adds users.source and email_verification_codes", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'admin'/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS email_verification_codes/);
    expect(sql).toMatch(/purpose TEXT NOT NULL CHECK \(purpose IN \('register', 'reset'\)\)/);
    expect(sql).toMatch(/code_hash TEXT NOT NULL/);
    expect(sql).toMatch(/attempts INT NOT NULL DEFAULT 0/);
  });
});
