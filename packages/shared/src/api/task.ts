import type { TaskState } from "../domain/task.js";
import type { Severity } from "../domain/severity.js";

export interface AuditCompletionFingerprint {
  size: number;
  mtime_ms: number;
  sha256: string;
}

export type AuditCompletionErrorCode =
  | "ERR_AUDIT_COMPLETION_MISSING"
  | "ERR_AUDIT_COMPLETION_STALE"
  | "ERR_AUDIT_COMPLETION_INVALID"
  | "ERR_AUDIT_COMPLETION_UNSAFE";

export type AuditCompletionPlatformStatus =
  | "complete"
  | "incomplete"
  | "missing"
  | "stale"
  | "invalid"
  | "unsafe"
  | "legacy_missing"
  | "legacy_invalid"
  | "legacy_observed";

export interface TaskEngineRun {
  run_id: string;
  engine: "vulnforge";
  // Pinned provenance of the engine baseline that produced this run. Extend
  // the union (never widen to string) when the pinned VulnForge moves.
  engine_version: "2.0" | "2.0-5-g1782ef6";
  engine_commit: string;
  completion_contract: "audit-completion/v1";
  completion_required: true;
  started_at: string;
  previous_completion_fingerprint: AuditCompletionFingerprint | null;
}

export interface TaskAuditCompletion {
  contract_version: "1";
  status: AuditCompletionPlatformStatus;
  engine_status: "complete" | "incomplete" | null;
  reason: string | null;
  error_code: AuditCompletionErrorCode | null;
  artifact_key: "report/completion.yaml" | null;
  sha256: string | null;
  run_id: string | null;
  evaluated_at: string;
}

export interface TaskMetadata {
  engine_run?: TaskEngineRun;
  audit_completion?: TaskAuditCompletion;
  profile?: unknown;
  execution?: unknown;
  [key: string]: unknown;
}

export interface TaskSummary {
  id: string;
  tenant_id: string;
  project_name: string;
  state: TaskState;
  risk_score?: number;
  severity_counts: Record<Severity, number>;
  duration_ms?: number;
  total_duration_ms?: number;
  /** Completed run segments; 0/absent = unknown (hide UI segment count). */
  run_count?: number;
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

export interface CreateTaskRequest {
  project_name: string;
  source: { type: "upload"; filename: string } | { type: "git"; url: string; branch?: string };
  auto_report_skill_ids?: string[];
  /** Product output language (BCP-47). Default engine-side: zh-CN. */
  output_language?: "zh-CN" | "en";
  /** Vulnerability focus requirement. Empty = engine default. */
  vuln_focus?: string;
}
