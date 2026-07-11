import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EXP_STATUSES,
  FINDING_CLASSES,
  POC_STATUSES,
  isExpStatus,
  isFindingClass,
  isPocStatus,
  type FindingDynamicMeta,
} from "@vulnagent/shared";

const migration = readFileSync(
  new URL("../../src/infra/db/migrations/026_finding_dynamic_fields.sql", import.meta.url),
  "utf8",
);

describe("Finding dynamic shared contract", () => {
  it("expresses every frozen enum and the unknown sentinel", () => {
    expect(FINDING_CLASSES).toEqual(["vulnerability", "risk", "unknown"]);
    expect(POC_STATUSES).toEqual(["pending", "reproduced", "fail-reproduced", "blocked", "unknown"]);
    expect(EXP_STATUSES).toEqual(["pending", "confirmed", "downgraded", "failed", "blocked", "not-needed", "unknown"]);
  });

  it("type guards accept only frozen values", () => {
    for (const value of FINDING_CLASSES) expect(isFindingClass(value)).toBe(true);
    for (const value of POC_STATUSES) expect(isPocStatus(value)).toBe(true);
    for (const value of EXP_STATUSES) expect(isExpStatus(value)).toBe(true);
    for (const value of [null, "", "future-status", 1, {}]) {
      expect(isFindingClass(value)).toBe(false);
      expect(isPocStatus(value)).toBe(false);
      expect(isExpStatus(value)).toBe(false);
    }
  });

  it("keeps all four fields nullable and distinguishes affected_versions unknown", () => {
    const legacy: FindingDynamicMeta = {
      finding_class: null,
      poc_status: null,
      exp_status: null,
      affected_versions: null,
    };
    const engineUnknown: FindingDynamicMeta = {
      finding_class: "unknown",
      poc_status: "unknown",
      exp_status: "unknown",
      affected_versions: "unknown",
    };
    expect(legacy.affected_versions).toBeNull();
    expect(engineUnknown.affected_versions).toBe("unknown");
  });
});

describe("migration 026 contract", () => {
  it("adds exactly the four nullable TEXT columns without defaults/backfill/indexes", () => {
    for (const column of ["finding_class", "poc_status", "exp_status", "affected_versions"]) {
      expect(migration).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${column} TEXT`));
    }
    expect(migration).not.toMatch(/\bDEFAULT\b/i);
    expect(migration).not.toMatch(/\bUPDATE\s+findings_meta\b/i);
    expect(migration).not.toMatch(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i);
  });

  it("uses named idempotent CHECK constraints with unknown sentinels", () => {
    expect(migration).toContain("findings_meta_finding_class_check");
    expect(migration).toContain("findings_meta_poc_status_check");
    expect(migration).toContain("findings_meta_exp_status_check");
    expect(migration.match(/EXCEPTION WHEN duplicate_object THEN NULL/g)).toHaveLength(3);
    expect(migration).toContain("'fail-reproduced'");
    expect(migration).toContain("'not-needed'");
    expect(migration.match(/'unknown'/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
