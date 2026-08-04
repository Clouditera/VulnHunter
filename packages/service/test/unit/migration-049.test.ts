import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../src/infra/db/migrations/049_drop_poc_jobs.sql", import.meta.url),
  "utf8",
);

describe("migration 049 contract (manual POC chain tables drop)", () => {
  it("drops all four chain tables", () => {
    for (const table of ["poc_runs", "poc_results", "poc_jobs", "poc_settings"]) {
      expect(migration).toMatch(new RegExp(`DROP TABLE IF EXISTS ${table};`));
    }
  });

  it("drops in FK-safe order: poc_runs → poc_results → poc_jobs → poc_settings", () => {
    // poc_runs.result_id → poc_results; poc_results.job_id → poc_jobs
    const idxRuns = migration.indexOf("DROP TABLE IF EXISTS poc_runs;");
    const idxResults = migration.indexOf("DROP TABLE IF EXISTS poc_results;");
    const idxJobs = migration.indexOf("DROP TABLE IF EXISTS poc_jobs;");
    const idxSettings = migration.indexOf("DROP TABLE IF EXISTS poc_settings;");
    expect(idxRuns).toBeGreaterThanOrEqual(0);
    expect(idxRuns).toBeLessThan(idxResults);
    expect(idxResults).toBeLessThan(idxJobs);
    expect(idxJobs).toBeLessThan(idxSettings);
  });

  it("is idempotent (every drop uses IF EXISTS)", () => {
    const drops = migration.match(/DROP TABLE/g) ?? [];
    const ifExists = migration.match(/DROP TABLE IF EXISTS/g) ?? [];
    expect(drops.length).toBe(4);
    expect(ifExists.length).toBe(4);
  });

  it("contains no data-mutating statements beyond the drops", () => {
    expect(migration).not.toMatch(/DELETE FROM|UPDATE\s+\w+\s+SET|INSERT INTO/i);
  });
});
