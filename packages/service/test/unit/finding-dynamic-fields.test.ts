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
} from "@vulnhunter/shared";

const migration = readFileSync(
  new URL("../../src/infra/db/migrations/026_finding_dynamic_fields.sql", import.meta.url),
  "utf8",
);

const migration027 = readFileSync(
  new URL("../../src/infra/db/migrations/027_poc_status_not_needed.sql", import.meta.url),
  "utf8",
);

const migration058 = readFileSync(
  new URL("../../src/infra/db/migrations/058_exp_status_awaiting_poc.sql", import.meta.url),
  "utf8",
);

describe("Finding dynamic shared contract", () => {
  it("expresses every frozen enum and the unknown sentinel", () => {
    expect(FINDING_CLASSES).toEqual(["vulnerability", "risk", "unknown"]);
    expect(POC_STATUSES).toEqual(["pending", "reproduced", "fail-reproduced", "blocked", "not-needed", "unknown"]);
    // HALL-35: awaiting-poc = vulnerability created by verify, PoC not yet run
    // (engine advances it to pending only after a successful reproduction).
    expect(EXP_STATUSES).toEqual(["pending", "awaiting-poc", "confirmed", "downgraded", "failed", "blocked", "not-needed", "unknown"]);
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

describe("migration 027 contract (poc_status not-needed)", () => {
  it("re-adds the named poc_status CHECK with not-needed and keeps it nullable", () => {
    expect(migration027).toContain("DROP CONSTRAINT IF EXISTS findings_meta_poc_status_check");
    expect(migration027).toContain("ADD CONSTRAINT findings_meta_poc_status_check");
    expect(migration027).toContain("poc_status IS NULL OR poc_status IN");
    for (const value of ["'pending'", "'reproduced'", "'fail-reproduced'", "'blocked'", "'not-needed'", "'unknown'"]) {
      expect(migration027).toContain(value);
    }
    // Engine has no `upgraded` value (confirmed with fish); never add it.
    expect(migration027).not.toContain("'upgraded'");
  });

  it("stays idempotent and touches no other constraint/column", () => {
    expect(migration027).toContain("EXCEPTION WHEN duplicate_object THEN NULL");
    expect(migration027).not.toMatch(/finding_class_check|exp_status_check/);
    expect(migration027).not.toMatch(/ADD COLUMN|DROP COLUMN|\bUPDATE\s+findings_meta\b/i);
  });
});

describe("migration 058 contract (exp_status awaiting-poc, HALL-35)", () => {
  it("re-adds the named exp_status CHECK with awaiting-poc and keeps it nullable", () => {
    expect(migration058).toContain("DROP CONSTRAINT IF EXISTS findings_meta_exp_status_check");
    expect(migration058).toContain("ADD CONSTRAINT findings_meta_exp_status_check");
    expect(migration058).toContain("exp_status IS NULL OR exp_status IN");
    for (const value of ["'pending'", "'awaiting-poc'", "'confirmed'", "'downgraded'", "'failed'", "'blocked'", "'not-needed'", "'unknown'"]) {
      expect(migration058).toContain(value);
    }
  });

  it("stays idempotent and touches no other constraint/column", () => {
    expect(migration058).toContain("EXCEPTION WHEN duplicate_object THEN NULL");
    expect(migration058).not.toMatch(/finding_class_check|poc_status_check/);
    expect(migration058).not.toMatch(/ADD COLUMN|DROP COLUMN|\bUPDATE\s+findings_meta\b/i);
  });
});
