import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  ORACLE_RULES, PrepareSemanticOracleError, classifyArtifactGate, classifyParentGate,
  classifyRestrictedRun, emptySafeCounters, validateSafeProgress, writeSafeProgress,
} from "../support/prepare-semantic-safe-receipt.mjs";

const roots: string[] = [];
const fixed = {
  schema_version: "prepare-semantic-safe-progress/v1", fixture_id: "complete_cmake_with_tests_and_vendor",
  run_index: 1, run_uuid: "12345678-1234-1234-1234-123456789abc",
  main_commit: "0d60b6abe0105676cb47d028728911bf9872c206",
  oracle_sha256: "b0232e01569692a33ef0dafcdc4313fc06a1f674c9456dcad1a75c7edd991ffb",
  image_id: `sha256:${"a".repeat(64)}`,
};
function receipt(overrides: Record<string, unknown> = {}) {
  return { ...fixed, sequence: 1, phase: "run_start", state: "running", attempted_runs: 1, completed_runs: 0,
    worker_exit_code: null, worker_signal: null, spawn_error_code: null, prepare_error_code: null,
    runtime_category: null, oracle_rule: null, safe_counters: emptySafeCounters(), timestamp: "2026-07-12T00:00:00.000Z", ...overrides };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("M3-04 safe failure classification", () => {
  it("extracts only exact Prepare enums and redacted counters", () => {
    const raw = "provider error\nERR_PREPARE_SCHEMA_INVALID\nDONE: exit=3 duration=123ms turns=4 tools=3 tokens_in=11 tokens_out=12 tokens_cache_read=13 tokens_cache_write=14 tokens_total=50 api_errors=1 retries=2";
    expect(classifyRestrictedRun({ stderr: raw, status: 3, durationMs: 999 })).toEqual({
      worker_exit_code: 3, worker_signal: null, spawn_error_code: null,
      prepare_error_code: "ERR_PREPARE_SCHEMA_INVALID", runtime_category: "provider_failure",
      safe_counters: { duration_ms: 123, turns: 4, tools: 3, tokens_in: 11, tokens_out: 12, tokens_cache_read: 13, tokens_cache_write: 14, tokens_total: 50, api_errors: 1, retries: 2 },
    });
    expect(classifyRestrictedRun({ stderr: "ERR_PREPARE_FAKE", status: 3 }).prepare_error_code).toBeNull();
    expect(classifyRestrictedRun({ stderr: "provider retries exhausted", status: 3 }).runtime_category).toBe("provider_retries_exhausted");
    expect(classifyRestrictedRun({ stderr: "restricted extension error", status: 3 }).runtime_category).toBe("restricted_extension_failure");
    expect(classifyRestrictedRun({ stderr: "restricted process error", status: 3 }).runtime_category).toBe("restricted_process_failure");
    expect(classifyRestrictedRun({ stderr: "prepare token budget exceeded", status: 3 }).runtime_category).toBe("prepare_policy_budget_exceeded");
  });

  it("classifies timeout, signal, spawn error and local artifact gates", () => {
    expect(classifyRestrictedRun({ status: null, errorCode: "ETIMEDOUT" }).runtime_category).toBe("container_timeout");
    expect(classifyRestrictedRun({ status: null, signal: "SIGTERM" }).runtime_category).toBe("container_signal");
    expect(classifyRestrictedRun({ status: null, errorCode: "EPERM" }).spawn_error_code).toBe("OTHER");
    expect(classifyArtifactGate({ outputNames: [], controlEntries: 0, planExists: false, planMode: null })).toBe("plan_missing");
    expect(classifyArtifactGate({ outputNames: ["assessment-plan.json", "extra"], controlEntries: 0, planExists: true, planMode: 0o600 })).toBe("output_set_invalid");
    expect(classifyArtifactGate({ outputNames: ["assessment-plan.json"], controlEntries: 1, planExists: true, planMode: 0o600 })).toBe("control_not_cleaned");
    expect(classifyArtifactGate({ outputNames: ["assessment-plan.json"], controlEntries: 0, planExists: true, planMode: 0o644 })).toBe("plan_mode_invalid");
    expect(classifyParentGate({ readable: false, parseable: false })).toBe("plan_parse_invalid");
    expect(classifyParentGate({ readable: true, parseable: true })).toBeNull();
  });

  it("covers every typed oracle enum without expected/actual text", () => {
    for (const rule of ORACLE_RULES) {
      const error = new PrepareSemanticOracleError(rule);
      expect(error.rule).toBe(rule);
      expect(validateSafeProgress(receipt({ phase: "oracle_gate", state: "failed", runtime_category: "oracle_mismatch", oracle_rule: error.rule }))).toBeTruthy();
    }
  });
});

describe("M3-04 atomic safe progress", () => {
  it("tracks attempted/completed per run and writes mode 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "m304-safe-progress-")); roots.push(root); const path = join(root, "progress.json");
    writeSafeProgress(path, receipt());
    writeSafeProgress(path, receipt({ sequence: 2, phase: "run_complete", state: "passed", completed_runs: 1 }));
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved).toMatchObject({ sequence: 2, attempted_runs: 1, completed_runs: 1, phase: "run_complete", state: "passed" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => validateSafeProgress({ ...saved, raw_line: "forbidden" })).toThrow();
  });

  it("never copies synthetic secret, URL, header, source or fake exception text", () => {
    const raw = [
      "api_key=sk-SYNTHETIC-SECRET", "https://provider.invalid/v1", "Authorization: Bearer token",
      "SOURCE_EXCERPT_" + "x".repeat(100), "Error: fake provider exception", "ERR_PREPARE_FAKE",
      "provider error", "DONE: exit=3 duration=7ms turns=1 tools=0 tokens_in=2 tokens_out=3 tokens_cache_read=0 tokens_cache_write=0 tokens_total=5 api_errors=1 retries=0",
    ].join("\n");
    const classified = classifyRestrictedRun({ stderr: raw, status: 3 });
    const root = mkdtempSync(join(tmpdir(), "m304-safe-injection-")); roots.push(root); const path = join(root, "progress.json");
    writeSafeProgress(path, receipt({ sequence: 3, phase: "container_exit", state: "failed", ...classified }));
    const persisted = readFileSync(path, "utf8");
    for (const forbidden of ["SYNTHETIC", "provider.invalid", "Authorization", "SOURCE_EXCERPT", "fake provider exception", "ERR_PREPARE_FAKE"]) expect(persisted).not.toContain(forbidden);
    expect(persisted).toContain('"runtime_category":"provider_failure"');
  });
});
