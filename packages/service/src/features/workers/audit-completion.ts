import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { loadAll as yamlLoadAll } from "js-yaml";
import type {
  AuditCompletionErrorCode,
  AuditCompletionFingerprint,
  AuditCompletionPlatformStatus,
  TaskAuditCompletion,
  TaskEngineRun,
  TaskState,
} from "@vulnhunter/shared";

export const AUDIT_COMPLETION_CONTRACT = "audit-completion/v1" as const;
export const AUDIT_COMPLETION_RELATIVE_PATH = "report/completion.yaml" as const;
const MAX_BYTES = 64 * 1024;
const MAX_REASON_CHARS = 8192;

const ERROR_MESSAGES: Record<AuditCompletionErrorCode, string> = {
  ERR_AUDIT_COMPLETION_MISSING: "扫描引擎未生成本次运行的完成度文件，无法确认报告完整性。",
  ERR_AUDIT_COMPLETION_STALE: "本次运行未更新完成度文件，平台不会复用上一次运行的完成结论。",
  ERR_AUDIT_COMPLETION_INVALID: "扫描引擎生成的完成度文件不符合契约，无法确认报告完整性。",
  ERR_AUDIT_COMPLETION_UNSAFE: "扫描引擎生成的完成度文件未通过安全检查。",
};

export function createAuditCompletionEngineRun(
  runId: string,
  startedAt: string,
  previousCompletionFingerprint: AuditCompletionFingerprint | null,
): TaskEngineRun {
  return {
    run_id: runId,
    engine: "vulnforge",
    engine_version: "2.0-5-g1782ef6",
    engine_commit: "1782ef6d99db58fda74c8e1524b9237ca39cad2c",
    completion_contract: AUDIT_COMPLETION_CONTRACT,
    completion_required: true,
    started_at: startedAt,
    previous_completion_fingerprint: previousCompletionFingerprint,
  };
}

export interface AuditCompletionEvaluationOptions {
  outDir: string;
  engineRun?: TaskEngineRun | null;
  evaluatedAt?: string;
}

interface ReadResult {
  kind: "valid" | "missing" | "invalid" | "unsafe";
  fingerprint: AuditCompletionFingerprint | null;
  status?: "complete" | "incomplete";
  reason?: string;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

function hasUnsafeYamlSyntax(raw: string): boolean {
  // This two-field contract never needs YAML tags/references. The 64KiB cap
  // bounds parsing; this lexical guard rejects ordinary tag/anchor/alias use.
  return /(^|[\s[{,])(?:![^\s]+|[&*][A-Za-z0-9_-]+)/m.test(raw);
}

function sanitizeReason(raw: string): string {
  return raw
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

function containsSensitiveReason(reason: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(reason)
    || /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*\S+/i.test(reason)
    || /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i.test(reason)
    || /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i.test(reason);
}

function readCompletionFile(outDir: string): ReadResult {
  let rootFd: number;
  try {
    rootFd = openSync(outDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing", fingerprint: null }
      : { kind: "unsafe", fingerprint: null };
  }

  try {
    let root: string;
    try {
      root = realpathSync(`/proc/self/fd/${rootFd}`);
    } catch {
      return { kind: "unsafe", fingerprint: null };
    }
    const path = join(`/proc/self/fd/${rootFd}`, "report", "completion.yaml");
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { kind: "missing", fingerprint: null };
      return { kind: "unsafe", fingerprint: null };
    }

    try {
      const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) {
      return { kind: "unsafe", fingerprint: null };
    }
    let actualPath: string;
    try {
      // Bind containment to the object already opened with O_NOFOLLOW. Never
      // fall back to resolving `path`: a parent directory can be swapped
      // between open and realpath, producing a different object (TOCTOU).
      actualPath = realpathSync(`/proc/self/fd/${fd}`);
    } catch {
      return { kind: "unsafe", fingerprint: null };
    }
    if (!isWithin(root, actualPath) || !isWithin(root, realpathSync(dirname(actualPath)))) {
      return { kind: "unsafe", fingerprint: null };
    }

    const bytes = Buffer.alloc(stat.size);
    const read = readSync(fd, bytes, 0, stat.size, 0);
    if (read !== stat.size) return { kind: "invalid", fingerprint: null };
    const fingerprint: AuditCompletionFingerprint = {
      size: stat.size,
      mtime_ms: stat.mtimeMs,
      sha256: sha256(bytes),
    };

    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { kind: "invalid", fingerprint };
    }
    if (hasUnsafeYamlSyntax(raw)) return { kind: "unsafe", fingerprint };

    let docs: unknown[] = [];
    try {
      yamlLoadAll(raw, (doc) => docs.push(doc));
    } catch {
      return { kind: "invalid", fingerprint };
    }
    if (docs.length !== 1) return { kind: "invalid", fingerprint };
    const doc = docs[0];
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { kind: "invalid", fingerprint };
    const record = doc as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 2 || keys[0] !== "reason" || keys[1] !== "status") {
      return { kind: "invalid", fingerprint };
    }
    if (record.status !== "complete" && record.status !== "incomplete") {
      return { kind: "invalid", fingerprint };
    }
    if (typeof record.reason !== "string") return { kind: "invalid", fingerprint };
    const reason = sanitizeReason(record.reason);
    if (!reason || [...reason].length > MAX_REASON_CHARS) return { kind: "invalid", fingerprint };
    if (containsSensitiveReason(reason)) return { kind: "unsafe", fingerprint };
      return { kind: "valid", fingerprint, status: record.status, reason };
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(rootFd);
  }
}

export function fingerprintAuditCompletion(outDir: string): AuditCompletionFingerprint | null {
  try {
    return readCompletionFile(outDir).fingerprint;
  } catch {
    return null;
  }
}

function sameFingerprint(a: AuditCompletionFingerprint | null | undefined, b: AuditCompletionFingerprint | null): boolean {
  return !!a && !!b && a.size === b.size && a.mtime_ms === b.mtime_ms && a.sha256 === b.sha256;
}

export function evaluateAuditCompletion(options: AuditCompletionEvaluationOptions): TaskAuditCompletion {
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const engineRun = options.engineRun;
  const isNew = engineRun?.completion_contract === AUDIT_COMPLETION_CONTRACT && engineRun.completion_required === true;
  let read: ReadResult;
  try {
    read = readCompletionFile(options.outDir);
  } catch {
    read = { kind: "unsafe", fingerprint: null };
  }

  let status: AuditCompletionPlatformStatus;
  let errorCode: AuditCompletionErrorCode | null = null;
  let reason: string | null = null;
  let engineStatus: "complete" | "incomplete" | null = null;

  if (!isNew) {
    if (read.kind === "missing") status = "legacy_missing";
    else if (read.kind !== "valid") status = "legacy_invalid";
    else {
      status = "legacy_observed";
      engineStatus = read.status ?? null;
      reason = read.reason ?? null;
    }
  } else if (read.kind === "missing") {
    status = "missing";
    errorCode = "ERR_AUDIT_COMPLETION_MISSING";
    reason = ERROR_MESSAGES[errorCode];
  } else if (read.kind === "unsafe") {
    status = "unsafe";
    errorCode = "ERR_AUDIT_COMPLETION_UNSAFE";
    reason = ERROR_MESSAGES[errorCode];
  } else if (read.kind === "invalid") {
    status = "invalid";
    errorCode = "ERR_AUDIT_COMPLETION_INVALID";
    reason = ERROR_MESSAGES[errorCode];
  } else if (sameFingerprint(engineRun?.previous_completion_fingerprint, read.fingerprint)) {
    status = "stale";
    errorCode = "ERR_AUDIT_COMPLETION_STALE";
    reason = ERROR_MESSAGES[errorCode];
  } else {
    status = read.status!;
    engineStatus = read.status!;
    reason = read.reason!;
  }

  return {
    contract_version: "1",
    status,
    engine_status: engineStatus,
    reason,
    error_code: errorCode,
    artifact_key: read.kind === "missing" ? null : AUDIT_COMPLETION_RELATIVE_PATH,
    sha256: read.fingerprint?.sha256 ?? null,
    run_id: isNew ? engineRun?.run_id ?? null : null,
    evaluated_at: evaluatedAt,
  };
}

function eventLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

export function mapAuditCompletionFinalState(
  workerExitCode: number,
  completion: TaskAuditCompletion,
): { state: TaskState; failureReason?: string; severity: "info" | "warning" | "error"; eventReason: string } {
  if (workerExitCode !== 0) {
    return {
      state: "failed",
      failureReason: `Worker exited with code ${workerExitCode}`,
      severity: "error",
      eventReason: `Worker exited with code ${workerExitCode}`,
    };
  }
  if (["missing", "stale", "invalid", "unsafe"].includes(completion.status)) {
    return {
      state: "failed",
      failureReason: completion.reason ?? ERROR_MESSAGES.ERR_AUDIT_COMPLETION_INVALID,
      severity: "error",
      eventReason: completion.reason ?? ERROR_MESSAGES.ERR_AUDIT_COMPLETION_INVALID,
    };
  }
  if (completion.status === "incomplete") {
    const reason = eventLine(`审计未完整：${completion.reason}`);
    return { state: "completed", severity: "warning", eventReason: reason };
  }
  return {
    state: "completed",
    severity: "info",
    eventReason: completion.status === "complete" ? "审计完成度检查通过" : "扫描完成",
  };
}

export function mergeExecutionWarnings(existing: unknown, completion: TaskAuditCompletion): string | undefined {
  const existingWarning = typeof existing === "string" ? existing.trim() : "";
  if (completion.status !== "incomplete" || !completion.reason) {
    return existingWarning || undefined;
  }
  const completionWarning = `审计未完整：${completion.reason}`;
  if (existingWarning === completionWarning || existingWarning.endsWith(`；${completionWarning}`)) {
    return existingWarning;
  }
  return existingWarning ? `${existingWarning}；${completionWarning}` : completionWarning;
}

export function needsTerminalStateReconciliation(
  currentState: TaskState | undefined,
  completedAt: Date | string | null | undefined,
  mappedState: TaskState,
): boolean {
  return currentState !== mappedState || !completedAt;
}

export function isSameAuditCompletion(a: unknown, b: TaskAuditCompletion): boolean {
  if (!a || typeof a !== "object") return false;
  const current = a as Partial<TaskAuditCompletion>;
  return current.run_id === b.run_id && current.status === b.status && current.sha256 === b.sha256;
}
