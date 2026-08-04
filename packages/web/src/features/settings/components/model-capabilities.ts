/**
 * Model capabilities — thinking-level resolution for the credential form.
 *
 * The backend may extend POST /api/settings/models items with
 * { reasoning, thinking_levels }; when absent (backend not yet
 * capability-aware), fall back to the standard five levels so behaviour
 * matches today's UI.
 *
 * (Formerly credential-presets.ts — the vendor-preset half was removed
 * per fish 2026-08-04: single custom-endpoint form only.)
 */

/** Standard thinking levels (pi semantics for reasoning-marked models). */
export const STANDARD_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

export interface ModelCapabilities {
  reasoning: boolean;
  thinkingLevels: string[];
  /** catalog = pi 目录命中; endpoint = 端点上报; unknown = 无信息（回退标准档/手动） */
  source: "catalog" | "endpoint" | "unknown";
}

/**
 * Resolve capabilities for a model. The backend may extend
 * POST /api/settings/models items with { reasoning, thinking_levels };
 * when absent (backend not yet capability-aware), fall back to the
 * standard five levels so behaviour matches today's UI.
 */
export function resolveModelCapabilities(raw: unknown): ModelCapabilities {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const levels = Array.isArray(o.thinking_levels)
      ? (o.thinking_levels as unknown[]).filter((v): v is string => typeof v === "string")
      : null;
    if (typeof o.reasoning === "boolean") {
      return {
        reasoning: o.reasoning,
        thinkingLevels:
          o.reasoning && levels && levels.length > 0
            ? levels
            : o.reasoning
              ? [...STANDARD_THINKING_LEVELS]
              : ["off"],
        source: levels ? "catalog" : "endpoint",
      };
    }
  }
  return { reasoning: true, thinkingLevels: [...STANDARD_THINKING_LEVELS], source: "unknown" };
}
