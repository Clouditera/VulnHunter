import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../src/infra/db/migrations/030_finding_item_type_from_class.sql", import.meta.url),
  "utf8",
);

describe("migration 030 contract (finding item_type follows finding_class)", () => {
  it("backfills existing risk-class findings into the risk item type", () => {
    expect(migration).toMatch(/UPDATE\s+findings_meta/i);
    expect(migration).toMatch(/SET\s+item_type\s*=\s*'risk'/i);
    expect(migration).toMatch(/WHERE\s+finding_class\s*=\s*'risk'/i);
  });

  it("is narrowly scoped and does not rewrite legacy rows without finding_class", () => {
    expect(migration).not.toMatch(/UPDATE\s+findings_meta[\s\S]*finding_class\s+IS\s+NULL/i);
    expect(migration).not.toMatch(/DELETE|DROP\s+(TABLE|COLUMN)/i);
  });
});
