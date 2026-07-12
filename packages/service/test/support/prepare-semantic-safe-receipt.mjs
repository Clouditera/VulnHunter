import { closeSync, constants, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const PREPARE_ERROR_CODES = new Set([
  "ERR_PREPARE_SOURCE_INVALID", "ERR_PREPARE_MANIFEST_FAILED", "ERR_PREPARE_PLAN_TIMEOUT",
  "ERR_PREPARE_PLANNER_FAILED", "ERR_PREPARE_OUTPUT_MISSING", "ERR_PREPARE_SCHEMA_INVALID",
  "ERR_PREPARE_OUTPUT_SENSITIVE", "ERR_PREPARE_INTERNAL",
]);
export const RUNTIME_CATEGORIES = new Set([
  "provider_failure", "provider_retries_exhausted", "restricted_extension_failure",
  "restricted_process_failure", "prepare_policy_budget_exceeded", "container_nonzero",
  "container_timeout", "container_signal", "output_set_invalid", "plan_missing", "plan_mode_invalid",
  "plan_parse_invalid", "control_not_cleaned", "oracle_mismatch", "harness_internal", "unknown",
]);
export const ORACLE_RULES = new Set([
  "status", "submission_shape", "missing_categories", "uncertainty_codes", "stage_status_static",
  "stage_status_build", "stage_status_poc", "stage_status_exp", "sandbox_nullability",
  "required_capabilities", "root_candidates", "evidence_paths", "evidence_signals",
  "recommendation_codes", "external_dependency_roles", "warning_codes", "confidence",
  "dependency_egress", "profile_recommendation", "missing_component_semantics", "summary_semantics",
  "stonesoup_roots", "stonesoup_summary", "stonesoup_recommendation", "stonesoup_evidence",
  "forbidden_recommendation", "internal_path", "sensitive_content", "source_excerpt",
  "unauthorized_tool", "unknown",
]);
const PHASES = new Set(["run_start", "container_exit", "artifact_gate", "parent_gate", "oracle_gate", "run_complete"]);
const STATES = new Set(["running", "passed", "failed", "cancelled", "wall_timeout"]);
const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGABRT"]);
const SPAWN_ERRORS = new Set(["ETIMEDOUT", "ENOENT", "EACCES", "OTHER"]);
const COUNTERS = ["duration_ms", "turns", "tools", "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write", "tokens_total", "api_errors", "retries"];
const RECEIPT_KEYS = new Set([
  "schema_version", "sequence", "fixture_id", "run_index", "phase", "state", "attempted_runs",
  "completed_runs", "worker_exit_code", "worker_signal", "spawn_error_code", "prepare_error_code",
  "runtime_category", "oracle_rule", "safe_counters", "timestamp", "run_uuid", "main_commit",
  "oracle_sha256", "image_id",
]);

export class PrepareSemanticOracleError extends Error {
  constructor(rule) { super(`prepare semantic oracle rule failed: ${rule}`); this.name = "PrepareSemanticOracleError"; this.rule = ORACLE_RULES.has(rule) ? rule : "unknown"; }
}

function nonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function nullable(value, predicate) { return value === null || predicate(value); }

export function validateSafeProgress(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || Object.keys(receipt).some((key) => !RECEIPT_KEYS.has(key))) throw new Error("invalid safe progress shape");
  if (receipt.schema_version !== "prepare-semantic-safe-progress/v1" || !nonnegativeInteger(receipt.sequence) || receipt.sequence < 1) throw new Error("invalid safe progress version");
  if (!/^[a-z0-9_]+$/.test(receipt.fixture_id) || !Number.isSafeInteger(receipt.run_index) || receipt.run_index < 1 || receipt.run_index > 3) throw new Error("invalid fixed run identity");
  if (!PHASES.has(receipt.phase) || !STATES.has(receipt.state)) throw new Error("invalid safe progress state");
  if (!nonnegativeInteger(receipt.attempted_runs) || !nonnegativeInteger(receipt.completed_runs) || receipt.completed_runs > receipt.attempted_runs) throw new Error("invalid run counters");
  if (!nullable(receipt.worker_exit_code, Number.isSafeInteger) || !nullable(receipt.worker_signal, (value) => SIGNALS.has(value))) throw new Error("invalid process result");
  if (!nullable(receipt.spawn_error_code, (value) => SPAWN_ERRORS.has(value)) || !nullable(receipt.prepare_error_code, (value) => PREPARE_ERROR_CODES.has(value))) throw new Error("invalid safe error code");
  if (!nullable(receipt.runtime_category, (value) => RUNTIME_CATEGORIES.has(value)) || !nullable(receipt.oracle_rule, (value) => ORACLE_RULES.has(value))) throw new Error("invalid safe classification");
  if (!receipt.safe_counters || typeof receipt.safe_counters !== "object" || Object.keys(receipt.safe_counters).some((key) => !COUNTERS.includes(key))) throw new Error("invalid safe counters");
  for (const key of COUNTERS) if (!nonnegativeInteger(receipt.safe_counters[key])) throw new Error("invalid safe counter");
  if (typeof receipt.timestamp !== "string" || !/^\d{4}-\d\d-\d\dT/.test(receipt.timestamp)) throw new Error("invalid timestamp");
  if (!/^[0-9a-f-]{36}$/.test(receipt.run_uuid) || !/^[0-9a-f]{40}$/.test(receipt.main_commit) || !/^[0-9a-f]{64}$/.test(receipt.oracle_sha256) || !/^sha256:[0-9a-f]{64}$/.test(receipt.image_id)) throw new Error("invalid fixed identity");
  return receipt;
}

export function writeSafeProgress(path, receipt) {
  validateSafeProgress(receipt);
  const dir = dirname(path); const temp = join(dir, `.${basename(path)}.${process.pid}.${receipt.sequence}.tmp`);
  const bytes = `${JSON.stringify(receipt)}\n`;
  let fd;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, bytes, { encoding: "utf8" }); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path);
    const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); fsyncSync(dirFd); closeSync(dirFd);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

export function emptySafeCounters(durationMs = 0) {
  return { duration_ms: Math.max(0, Math.trunc(durationMs)), turns: 0, tools: 0, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0, tokens_total: 0, api_errors: 0, retries: 0 };
}

function exactPrepareCode(raw) {
  for (const code of PREPARE_ERROR_CODES) if (new RegExp(`(?:^|[^A-Z_])${code}(?:$|[^A-Z_])`).test(raw)) return code;
  return null;
}

function parseSafeCounters(raw, fallbackDuration) {
  const counters = emptySafeCounters(fallbackDuration);
  const matches = [...raw.matchAll(/DONE: exit=-?\d+ duration=(\d+)ms turns=(\d+) tools=(\d+) tokens_in=(\d+) tokens_out=(\d+) tokens_cache_read=(\d+) tokens_cache_write=(\d+) tokens_total=(\d+) api_errors=(\d+) retries=(\d+)/g)];
  const match = matches.at(-1);
  if (!match) return counters;
  ["duration_ms", "turns", "tools", "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write", "tokens_total", "api_errors", "retries"].forEach((key, index) => { counters[key] = Number(match[index + 1]); });
  return counters;
}

export function classifyArtifactGate({ outputNames, controlEntries, planExists, planMode }) {
  if (!planExists) return "plan_missing";
  if (JSON.stringify([...outputNames].sort()) !== JSON.stringify(["assessment-plan.json"])) return "output_set_invalid";
  if (controlEntries !== 0) return "control_not_cleaned";
  if (planMode !== 0o600) return "plan_mode_invalid";
  return null;
}

export function classifyParentGate({ readable, parseable }) {
  return readable && parseable ? null : "plan_parse_invalid";
}

export function classifyRestrictedRun({ stdout = "", stderr = "", status = null, signal = null, errorCode = null, durationMs = 0 }) {
  const raw = `${String(stdout).slice(-8 * 1024 * 1024)}\n${String(stderr).slice(-8 * 1024 * 1024)}`;
  const spawn = errorCode == null ? null : SPAWN_ERRORS.has(errorCode) ? errorCode : "OTHER";
  const safeSignal = signal != null && SIGNALS.has(signal) ? signal : null;
  let runtime = null;
  if (spawn === "ETIMEDOUT") runtime = "container_timeout";
  else if (spawn) runtime = "harness_internal";
  else if (safeSignal) runtime = "container_signal";
  else if (raw.includes("provider retries exhausted")) runtime = "provider_retries_exhausted";
  else if (raw.includes("provider error")) runtime = "provider_failure";
  else if (raw.includes("restricted extension error")) runtime = "restricted_extension_failure";
  else if (raw.includes("restricted process error")) runtime = "restricted_process_failure";
  else if (/prepare (?:turn|token) budget exceeded|idle_timeout|event=timeout/.test(raw)) runtime = "prepare_policy_budget_exceeded";
  else if (status !== 0) runtime = "container_nonzero";
  return { worker_exit_code: Number.isSafeInteger(status) ? status : null, worker_signal: safeSignal, spawn_error_code: spawn, prepare_error_code: exactPrepareCode(raw), runtime_category: runtime, safe_counters: parseSafeCounters(raw, durationMs) };
}
