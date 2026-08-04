/**
 * Credential presets — "官方预设" (vendor presets) vs "自定义 endpoint".
 *
 * A preset pins the protocol and pre-fills the base URL so the user only
 * supplies an API key (+ optional model). The credential's type is derived
 * from its base_url (no storage change required): matching a preset's
 * well-known host renders the preset badge; anything else is "custom".
 *
 * Spec: architecture/llm-layer-unify-pi-version-native-credential-test-v1.0.md §⑦
 */

export interface CredentialPreset {
  id: string;
  /** i18n key for the display name. */
  nameKey: string;
  protoType: string;
  defaultBaseUrl: string;
  /** Host substrings used to recognize existing credentials. */
  matchHosts: string[];
  /** Suggested model id placeholder for the model field. */
  modelHint: string;
}

export const CREDENTIAL_PRESETS: readonly CredentialPreset[] = [
  {
    id: "deepseek",
    nameKey: "settings.creds.preset.deepseek",
    protoType: "openai-completions",
    defaultBaseUrl: "https://api.deepseek.com",
    matchHosts: ["api.deepseek.com"],
    modelHint: "deepseek-v4-pro",
  },
  {
    id: "anthropic",
    nameKey: "settings.creds.preset.anthropic",
    protoType: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    matchHosts: ["api.anthropic.com"],
    modelHint: "claude-sonnet-4.5",
  },
  {
    id: "openai",
    nameKey: "settings.creds.preset.openai",
    protoType: "openai-completions",
    defaultBaseUrl: "https://api.openai.com",
    matchHosts: ["api.openai.com"],
    modelHint: "gpt-5",
  },
  {
    id: "cloudrouter",
    nameKey: "settings.creds.preset.cloudrouter",
    protoType: "openai-completions",
    defaultBaseUrl: "https://console.cloudrouter.online",
    matchHosts: ["cloudrouter.online"],
    modelHint: "deepseek-v4-flash",
  },
] as const;

export type CredentialType = "preset" | "custom";

/** Derive the preset for an existing credential from its base_url. */
export function detectPreset(baseUrl: string | null | undefined): CredentialPreset | null {
  if (!baseUrl) return null;
  const url = baseUrl.toLowerCase();
  return CREDENTIAL_PRESETS.find((p) => p.matchHosts.some((h) => url.includes(h))) ?? null;
}

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
