import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../src/infra/db/migrations/040_user_onboarding.sql", import.meta.url),
  "utf8",
);

describe("migration 040 user onboarding", () => {
  it("adds onboarding_dismissed_at nullable timestamptz", () => {
    expect(migration).toMatch(
      /ADD COLUMN IF NOT EXISTS onboarding_dismissed_at TIMESTAMPTZ/,
    );
  });
});
