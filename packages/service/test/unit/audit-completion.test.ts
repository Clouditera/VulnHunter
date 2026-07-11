import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskEngineRun } from "@vulnagent/shared";
import {
  AUDIT_COMPLETION_CONTRACT,
  createAuditCompletionEngineRun,
  evaluateAuditCompletion,
  fingerprintAuditCompletion,
  isSameAuditCompletion,
  mapAuditCompletionFinalState,
  mergeExecutionWarnings,
} from "../../src/features/workers/audit-completion.js";

const roots: string[] = [];
const fixtureDir = new URL("../fixtures/audit-completion/", import.meta.url);

function workspace(): { root: string; out: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "audit-completion-"));
  roots.push(root);
  const out = join(root, "out");
  const report = join(out, "report");
  mkdirSync(report, { recursive: true });
  return { root, out, file: join(report, "completion.yaml") };
}

function fixture(name: string): string {
  return readFileSync(new URL(name, fixtureDir), "utf8");
}

function marker(previous: TaskEngineRun["previous_completion_fingerprint"] = null): TaskEngineRun {
  return {
    run_id: "run-1",
    engine: "vulnforge",
    engine_version: "2.0",
    engine_commit: "058da50be533b4605ff2e1614cef77b5c2d936bd",
    completion_contract: AUDIT_COMPLETION_CONTRACT,
    completion_required: true,
    started_at: "2026-07-11T00:00:00.000Z",
    previous_completion_fingerprint: previous,
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("audit completion C01-C13", () => {
  it("creates the frozen engine_run marker without user-controlled fields", () => {
    const run = createAuditCompletionEngineRun("run-2", "started", null);
    expect(run).toEqual({
      run_id: "run-2",
      engine: "vulnforge",
      engine_version: "2.0",
      engine_commit: "058da50be533b4605ff2e1614cef77b5c2d936bd",
      completion_contract: "audit-completion/v1",
      completion_required: true,
      started_at: "started",
      previous_completion_fingerprint: null,
    });
  });

  it("C01 maps a new complete artifact to completed/info", () => {
    const { out, file } = workspace();
    writeFileSync(file, fixture("complete.yaml"));
    const result = evaluateAuditCompletion({ outDir: out, engineRun: marker(), evaluatedAt: "now" });
    expect(result).toMatchObject({ status: "complete", engine_status: "complete", error_code: null, run_id: "run-1" });
    expect(mapAuditCompletionFinalState(0, result)).toMatchObject({ state: "completed", severity: "info" });
  });

  it("C02 preserves incomplete reason and maps completed/warning", () => {
    const { out, file } = workspace();
    writeFileSync(file, fixture("incomplete.yaml"));
    const result = evaluateAuditCompletion({ outDir: out, engineRun: marker() });
    expect(result.status).toBe("incomplete");
    expect(result.reason).toContain("管理端导入链路");
    expect(mapAuditCompletionFinalState(0, result)).toMatchObject({ state: "completed", severity: "warning" });
  });

  it("C03 new missing fails while C12 legacy missing preserves completion", () => {
    const { out } = workspace();
    const current = evaluateAuditCompletion({ outDir: out, engineRun: marker() });
    expect(current).toMatchObject({ status: "missing", error_code: "ERR_AUDIT_COMPLETION_MISSING" });
    expect(mapAuditCompletionFinalState(0, current).state).toBe("failed");
    const legacy = evaluateAuditCompletion({ outDir: out });
    expect(legacy.status).toBe("legacy_missing");
    expect(mapAuditCompletionFinalState(0, legacy).state).toBe("completed");
  });

  it.each([
    ["invalid-status.yaml", "invalid"],
    ["invalid-extra-field.yaml", "invalid"],
    ["malformed.yaml", "invalid"],
    ["empty-reason.yaml", "invalid"],
  ])("C04-C07 rejects %s as %s without raw leakage", (name, status) => {
    const { out, file } = workspace();
    const raw = fixture(name);
    writeFileSync(file, raw);
    const result = evaluateAuditCompletion({ outDir: out, engineRun: marker() });
    expect(result.status).toBe(status);
    expect(result.error_code).toBe("ERR_AUDIT_COMPLETION_INVALID");
    expect(result.reason).not.toContain(raw);
  });

  it("C08 rejects symlink and unsafe YAML references", () => {
    const first = workspace();
    const target = join(first.root, "target.yaml");
    writeFileSync(target, fixture("complete.yaml"));
    symlinkSync(target, first.file);
    expect(evaluateAuditCompletion({ outDir: first.out, engineRun: marker() }).status).toBe("unsafe");

    const second = workspace();
    writeFileSync(second.file, "status: &s complete\nreason: *s\n");
    expect(evaluateAuditCompletion({ outDir: second.out, engineRun: marker() }).status).toBe("unsafe");
  });

  it("C09 rejects empty and oversized files", () => {
    const empty = workspace();
    writeFileSync(empty.file, "");
    expect(evaluateAuditCompletion({ outDir: empty.out, engineRun: marker() }).status).toBe("unsafe");
    const large = workspace();
    writeFileSync(large.file, `status: complete\nreason: ${"x".repeat(65_536)}\n`);
    expect(evaluateAuditCompletion({ outDir: large.out, engineRun: marker() }).status).toBe("unsafe");
  });

  it("C10 marks unchanged Continue artifact stale", () => {
    const { out, file } = workspace();
    writeFileSync(file, fixture("complete.yaml"));
    const previous = fingerprintAuditCompletion(out);
    const result = evaluateAuditCompletion({ outDir: out, engineRun: marker(previous) });
    expect(result).toMatchObject({ status: "stale", error_code: "ERR_AUDIT_COMPLETION_STALE" });
  });

  it("C11 accepts rewritten identical content when mtime changes", () => {
    const { out, file } = workspace();
    const raw = fixture("complete.yaml");
    writeFileSync(file, raw);
    const previous = fingerprintAuditCompletion(out)!;
    writeFileSync(file, raw);
    utimesSync(file, new Date(previous.mtime_ms + 2000), new Date(previous.mtime_ms + 2000));
    expect(evaluateAuditCompletion({ outDir: out, engineRun: marker(previous) }).status).toBe("complete");
  });

  it("C13 legacy malformed remains legacy_invalid and completed", () => {
    const { out, file } = workspace();
    writeFileSync(file, fixture("malformed.yaml"));
    const result = evaluateAuditCompletion({ outDir: out });
    expect(result.status).toBe("legacy_invalid");
    expect(mapAuditCompletionFinalState(0, result).state).toBe("completed");
  });
});

describe("audit completion C14-C18 and security", () => {
  it("C14 worker runtime failure remains primary while metadata is retained", () => {
    const { out, file } = workspace();
    writeFileSync(file, fixture("complete.yaml"));
    const result = evaluateAuditCompletion({ outDir: out, engineRun: marker() });
    expect(mapAuditCompletionFinalState(17, result)).toMatchObject({
      state: "failed",
      failureReason: "Worker exited with code 17",
    });
    expect(result.status).toBe("complete");
  });

  it("C15/C18 duplicate evaluation has the same idempotency identity", () => {
    const { out, file } = workspace();
    writeFileSync(file, fixture("complete.yaml"));
    const first = evaluateAuditCompletion({ outDir: out, engineRun: marker(), evaluatedAt: "first" });
    const second = evaluateAuditCompletion({ outDir: out, engineRun: marker(), evaluatedAt: "second" });
    expect(isSameAuditCompletion(first, second)).toBe(true);
    expect(first.sha256).toBe(second.sha256);
  });

  it("C16 merges stage and incomplete warnings", () => {
    const { out, file } = workspace();
    writeFileSync(file, fixture("incomplete.yaml"));
    const result = evaluateAuditCompletion({ outDir: out, engineRun: marker() });
    expect(mergeExecutionWarnings("2 agent/stage failures", result)).toContain("2 agent/stage failures；审计未完整：");
  });

  it("C17 incremental sync list does not include report", () => {
    const scheduler = readFileSync(new URL("../../src/features/workers/scheduler.ts", import.meta.url), "utf8");
    expect(scheduler).toContain('const INCREMENTAL_SYNC_DIRS = ["findings", "risks", "knowledge"]');
    expect(scheduler).not.toMatch(/INCREMENTAL_SYNC_DIRS\s*=\s*\[[^\]]*"report"/);
  });

  it("rejects reason containing credentials and strips ANSI/control characters", () => {
    const unsafe = workspace();
    writeFileSync(unsafe.file, "status: incomplete\nreason: 'api_key=topsecretvalue'\n");
    const rejected = evaluateAuditCompletion({ outDir: unsafe.out, engineRun: marker() });
    expect(rejected.status).toBe("unsafe");
    expect(rejected.reason).not.toContain("topsecretvalue");

    const safe = workspace();
    writeFileSync(safe.file, 'status: incomplete\nreason: "\\u001b[31m缺口\\u001b[0m\\u0007"\n');
    const sanitized = evaluateAuditCompletion({ outDir: safe.out, engineRun: marker() });
    expect(sanitized.status).toBe("incomplete");
    expect(sanitized.reason).toBe("缺口");
  });
});
