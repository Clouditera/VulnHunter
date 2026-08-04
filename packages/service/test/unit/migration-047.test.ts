import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../src/infra/db/migrations/047_task_metadata_unwrap.sql", import.meta.url),
  "utf8",
);

describe("migration 047 contract (tasks.metadata string-form unwrap)", () => {
  it("targets only string-typed JSONB metadata rows", () => {
    expect(migration).toMatch(/FROM\s+tasks\s+WHERE\s+jsonb_typeof\(metadata\)\s*=\s*'string'/);
  });

  it("unwraps via text extraction and re-parse (double-encoded → object)", () => {
    expect(migration).toContain("metadata #>> '{}'");
    expect(migration).toMatch(/unwrapped\s*:=\s*r\.txt::jsonb/);
    expect(migration).toMatch(/UPDATE\s+tasks\s+SET\s+metadata\s*=\s*unwrapped/);
  });

  it("only writes back rows that re-parse to a JSONB object", () => {
    expect(migration).toMatch(/IF\s+jsonb_typeof\(unwrapped\)\s*=\s*'object'\s+THEN/);
  });

  it("is failure-tolerant per row (bad rows skipped with WARNING, migration continues)", () => {
    expect(migration).toMatch(/EXCEPTION\s+WHEN\s+others\s+THEN/i);
    expect(migration).toMatch(/RAISE\s+WARNING/i);
  });

  it("is non-destructive (no DROP / DELETE / blind overwrite)", () => {
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
    // every UPDATE is guarded by the object-type check above
    expect(migration).not.toMatch(/SET\s+metadata\s*=\s*metadata/i);
  });
});
