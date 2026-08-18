/**
 * Prepare result contract (v2 — prepare internalized into the onboard gate).
 *
 * Historical home was features/workers/prepare-worker.ts (one-shot container
 * MODE=prepare). The prepare infrastructure is retired (plan §4.4): the
 * completeness/sandbox-selection decision now runs inside the scan worker's
 * onboard stage and is submitted back to the service via
 * POST /internal/prepare-result. This module is the single source of truth
 * for the three-field contract shared by the flow prompt, the submit script,
 * and the callback endpoint.
 */

/** The three-field Prepare result contract (P1/P2 frozen). */
export interface PrepareResult {
  project_complete: boolean;
  sandbox_type: string | null;
  reason: "complete" | "partial_source" | "fragment_collection" | "no_compatible_sandbox";
}

export const PREPARE_RESULT_REASONS = [
  "complete",
  "partial_source",
  "fragment_collection",
  "no_compatible_sandbox",
] as const;

function booleanMeta(meta: Record<string, unknown> | null | undefined, key: string): boolean {
  const v = meta?.[key];
  return v === true || v === "true";
}

/**
 * Whether the task's "动态验证/评估" (dynamic verification/assessment) switch is
 * on. Read from source_meta.dynamic_enabled; the task-creation batch (B3)
 * writes it there. Absent → false (static-only), preserving existing behavior.
 */
export function isDynamicEnabled(task: { source_meta?: Record<string, unknown> | null }): boolean {
  return booleanMeta(task.source_meta, "dynamic_enabled");
}

/**
 * Parse + validate a PrepareResult from an untrusted JSON body (the callback
 * endpoint). Returns null on any shape violation — callers fail closed.
 */
export function parsePrepareResult(value: unknown): PrepareResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.project_complete !== "boolean") return null;
  if (v.sandbox_type !== null && typeof v.sandbox_type !== "string") return null;
  if (typeof v.sandbox_type === "string" && v.sandbox_type.trim() === "") return null;
  if (!PREPARE_RESULT_REASONS.includes(v.reason as PrepareResult["reason"])) return null;
  return {
    project_complete: v.project_complete,
    sandbox_type: (v.sandbox_type as string | null) ?? null,
    reason: v.reason as PrepareResult["reason"],
  };
}

/** Task metadata shape persisted at gate completion (metadata.prepare). */
export interface PersistedPrepareMeta extends PrepareResult {
  dynamic_enabled: boolean;
  at: string;
}

/**
 * Validate a persisted metadata.prepare object (continue/resume reuse path).
 * Returns the PrepareResult when the shape is usable, else null.
 */
export function persistedPrepareResult(
  persisted: unknown,
): PrepareResult | null {
  if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)) return null;
  return parsePrepareResult(persisted);
}
