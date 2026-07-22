import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("migration 032 user agreement acceptances", () => {
  const sql = readFileSync(
    resolve(__dirname, "../../src/infra/db/migrations/032_user_agreement_acceptances.sql"),
    "utf8",
  );

  it("creates acceptance table with version + timestamp", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS user_agreement_acceptances/);
    expect(sql).toMatch(/agreement_id TEXT NOT NULL/);
    expect(sql).toMatch(/agreement_version TEXT NOT NULL/);
    expect(sql).toMatch(/accepted_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
    expect(sql).toMatch(/UNIQUE \(user_id, agreement_id, agreement_version\)/);
  });
});
