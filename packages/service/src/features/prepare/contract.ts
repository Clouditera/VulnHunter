/**
 * Gate contracts (v3 — engine-native gate, spec
 * onboard-gate-engine-native-v1.0). The three-field prepare contract survives
 * as metadata.prepare; the runtime gate is now gate.yaml written by the
 * onboard stage and routed natively by youngflow (the /internal/prepare-result
 * callback endpoint and submit-prepare-result.sh are retired). This module is
 * the single source of truth for both shapes.
 */

import { load as parseYaml } from "js-yaml";

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

/**
 * gate.yaml reason enum (engine-native gate, v1.0 spec §1): the prepare
 * contract reasons + sandbox_unavailable (apply_sandbox failed — the agent
 * could not obtain a sandbox for a dynamic task).
 */
export const GATE_REASONS = [...PREPARE_RESULT_REASONS, "sandbox_unavailable"] as const;
export type GateReason = (typeof GATE_REASONS)[number];

/** Parsed gate.yaml (workspace root = out/). */
export interface GateYaml {
  next: "continue" | "end";
  reason: GateReason;
  detail?: string;
  sandbox_type?: string | null;
}

/**
 * Parse + validate gate.yaml content from an untrusted YAML string. Returns
 * null on any shape violation — callers fail closed.
 */
export function parseGateYaml(text: string): GateYaml | null {
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.next !== "continue" && v.next !== "end") return null;
  if (!GATE_REASONS.includes(v.reason as GateReason)) return null;
  if (v.sandbox_type !== undefined && v.sandbox_type !== null && typeof v.sandbox_type !== "string") return null;
  if (v.detail !== undefined && typeof v.detail !== "string") return null;
  return {
    next: v.next,
    reason: v.reason as GateReason,
    detail: typeof v.detail === "string" ? v.detail : undefined,
    sandbox_type: (v.sandbox_type as string | null | undefined) ?? null,
  };
}

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
