/**
 * Dynamic capability toggle mapping (B3 single source of truth).
 *
 * Both task-creation channels — the web form (files/routes.ts) and the chat
 * agent (createMcpTask) — must produce equivalent task source_meta, so the
 * mapping lives here exactly once and both call it.
 *
 * User-facing toggles (PRD §0):
 *   动态验证/评估 (dynamic verify)  → enable_poc=true + enable_exp=true + dynamic_enabled=true
 *   动态利用     (dynamic exploit) → enable_chain=true  (requires 动态验证/评估)
 * Both off → pure static scan: no enable-poc/exp/chain or dynamic_enabled
 * fields written.
 *
 * `dynamic_enabled` is the onboard gate's dynamic switch (the in-worker gate
 * reads source_meta.dynamic_enabled via the scheduler/env): when 动态验证/评估
 * is on, the platform selects a sandbox for the dynamic pipeline, so the gate's
 * sandbox step must query SandboxPlane.
 *
 * NOTE: the engine does not yet consume enable_poc/enable_exp/enable_chain
 * (scanInputEnvFromMeta / VULNFORGE_SCHED_INSTR is force-static). Flipping the
 * engine's dynamic inputs is the dynamic-closure batch (H5 §5), out of scope
 * here — this module only writes the meta correctly.
 */

export interface DynamicToggleInput {
  enableDynamicVerify?: unknown;
  enableDynamicExploit?: unknown;
}

/** Community edition: dynamic verification is enterprise/saas-only. The form
 * field is accepted but silently ignored (logged) — a hard 400 would break
 * older clients and the disabled-with-hint UI already communicates the limit
 * (architect spec task-8a290a7d ①, lhy decision 2026-08-24). */
export function resolveDynamicTogglesForEdition(
  input: DynamicToggleInput,
  edition: "community" | "enterprise" | "saas",
): DynamicToggleMeta {
  if (edition === "community") {
    if (toBool(input.enableDynamicVerify) || toBool(input.enableDynamicExploit)) {
      // Accepted-but-ignored: field still round-trips, meta stays static-only.
      return {};
    }
    return {};
  }
  return resolveDynamicToggles(input);
}

export interface DynamicToggleMeta {
  enable_poc?: boolean;
  enable_exp?: boolean;
  enable_chain?: boolean;
  dynamic_enabled?: boolean;
}

function toBool(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Map the two user-facing toggles to task source_meta fields.
 * Throws when 动态利用 is on without 动态验证/评估 (callers surface a 400).
 */
export function resolveDynamicToggles(input: DynamicToggleInput): DynamicToggleMeta {
  const verify = toBool(input.enableDynamicVerify);
  const exploit = toBool(input.enableDynamicExploit);
  if (exploit && !verify) {
    throw new Error("动态利用需要先开启动态验证/评估（enable_dynamic_exploit requires enable_dynamic_verify）");
  }
  const meta: DynamicToggleMeta = {};
  if (verify) {
    meta.enable_poc = true;
    meta.enable_exp = true;
    meta.dynamic_enabled = true;
  }
  if (exploit) meta.enable_chain = true;
  return meta;
}
