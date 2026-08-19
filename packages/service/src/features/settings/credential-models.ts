/**
 * Unified credential → models.json builder.
 *
 * Single source of truth for converting a DecryptedLlmCredential into the
 * models.json format that pi CLI / pi-ai consumes. Replaces five scattered
 * generation points (scan-mode.sh, report-mode.sh, worker-bridge main.ts,
 * l4-agent-check.ts, pi-diagnostics.ts buildModel).
 *
 * Design: docs/vulnhunt-srv/architecture/unified-credential-models-json-v1.0.md
 *
 * Key properties:
 * - API key is ALWAYS `$<ENV_VAR>` template — never plaintext on disk.
 * - Fields populated from pi catalog (builtinProviders) when available,
 *   overridden by credential scalars, then by advanced_config.
 * - Supports advanced_config (fish 2026-08-08): compat, thinkingLevelMap,
 *   input, cost — validated against a whitelist.
 */

import { logger } from "../../infra/logger.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface DecryptedCredentialLike {
  readonly proto_type: string;
  readonly base_url: string | null;
  readonly model_id: string;
  readonly thinking_effort: string;
  readonly context_window_tokens: number;
  /** Output limit. Null/absent → catalog real value → 128000 (fish 2026-08-19). */
  readonly max_output_tokens?: number | null;
  readonly api_key: string;
  readonly advanced_config?: AdvancedConfig | null;
}

export interface AdvancedConfig {
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    thinkingFormat?: string;
    maxTokensField?: string;
  };
  /**
   * Single-level send-value override (fish 2026-08-09 simplified thinking UI).
   * When set, buildModelsJson synthesizes a one-row thinkingLevelMap:
   *   { [thinking_effort]: thinkingLevelValue }
   * When absent, pi receives the level word as-is (no map).
   */
  thinkingLevelValue?: string;
  /**
   * @deprecated fish 2026-08-09 — seven-row map retired in favor of
   * thinkingLevelValue. Still accepted on read for migration: the row
   * matching the credential's thinking_effort becomes thinkingLevelValue.
   */
  thinkingLevelMap?: Record<string, string | null>;
  input?: ("text" | "image")[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface ModelsJsonResult {
  /** models.json file content (object; caller writes to disk) */
  readonly modelsJson: object;
  /** pi CLI child env (key injection) */
  readonly childEnv: Record<string, string>;
  /** provider/model reference for pi CLI flags */
  readonly providerKey: string;
  readonly modelRef: string;
}

// ── Proto type mapping ────────────────────────────────────────────────

type PiApiType = "openai-completions" | "anthropic-messages" | "openai-responses";

export function mapProtoToApi(protoType: string): PiApiType {
  if (protoType.startsWith("anthropic")) return "anthropic-messages";
  if (protoType === "openai-responses") return "openai-responses";
  return "openai-completions";
}

// ── Pi catalog lookup ─────────────────────────────────────────────────

let _catalogCache: { providerId: string; baseUrlPrefix: string; models: CatalogModel[] }[] | null = null;

interface CatalogModel {
  id: string;
  contextWindow: number | undefined;
  maxTokens: number | undefined;
  reasoning: boolean | undefined;
  compat: Record<string, unknown> | undefined;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
  input: ("text" | "image")[] | undefined;
}

/**
 * Lazily load pi-ai built-in catalog (38 providers, ~1153 models).
 * Cached after first call.
 */
async function loadCatalog(): Promise<typeof _catalogCache> {
  if (_catalogCache) return _catalogCache;

  try {
    const mod = await import("@earendil-works/pi-ai/providers/all");
    const providers = mod.builtinProviders();
    _catalogCache = providers.map((p: any) => ({
      providerId: p.id,
      baseUrlPrefix: (p.baseUrl ?? "").toLowerCase(),
      models: (p.getModels?.() ?? []).map((m: any) => ({
        id: m.id,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        reasoning: m.reasoning,
        compat: m.compat,
        cost: m.cost,
        input: m.input,
      })),
    }));
    logger.debug({ providerCount: _catalogCache.length }, "pi catalog loaded for credential-models");
    return _catalogCache;
  } catch (err) {
    logger.warn({ err: String(err) }, "Failed to load pi catalog — falling back to defaults");
    _catalogCache = [];
    return _catalogCache;
  }
}

/**
 * Look up model fields from pi catalog.
 * Matches by baseUrl prefix → model id.
 */
async function lookupCatalogModel(
  baseUrl: string,
  modelId: string,
  opts?: { thinkingFormat?: string },
): Promise<CatalogModel | null> {
  const catalog = await loadCatalog();
  if (!catalog || catalog.length === 0) return null;

  const normalizedBase = baseUrl.toLowerCase().replace(/\/+$/, "");

  // Try matching by baseUrl prefix (most reliable)
  for (const provider of catalog) {
    if (!provider.baseUrlPrefix || !normalizedBase.includes(provider.baseUrlPrefix.replace(/\/+$/, ""))) continue;
    const match = provider.models.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
    if (match) return match;
  }

  // Fallback: match by model id across all providers.
  // Affinity (fish/architect 2026-08-08): if advanced_config has a
  // thinkingFormat, prefer candidates whose compat.thinkingFormat matches.
  const thinkingFormat = opts?.thinkingFormat?.toLowerCase();
  const candidates: CatalogModel[] = [];
  for (const provider of catalog) {
    const match = provider.models.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
    if (match) candidates.push(match);
  }
  if (candidates.length === 0) return null;
  if (thinkingFormat) {
    const affinity = candidates.find(
      (m) => {
        const tf = (m.compat as Record<string, unknown> | undefined)?.thinkingFormat;
        return typeof tf === "string" && tf.toLowerCase() === thinkingFormat;
      },
    );
    if (affinity) return affinity;
  }
  return candidates[0];
}

// ── Advanced config validation ────────────────────────────────────────

const VALID_THINKING_FORMATS = [
  "openai", "openrouter", "together", "baseten", "deepseek",
  "zai", "qwen", "chat-template", "qwen-chat-template",
  "string-thinking", "ant-ling",
];
const VALID_MAX_TOKENS_FIELDS = ["max_tokens", "max_completion_tokens"];
const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Validate and normalize advanced_config. Throws on invalid fields.
 * Returns a clean AdvancedConfig or null if input is null/undefined.
 */
export function validateAdvancedConfig(raw: unknown): AdvancedConfig | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdvancedConfigError("advanced_config must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const result: AdvancedConfig = {};

  // compat
  if (obj.compat !== undefined) {
    if (typeof obj.compat !== "object" || Array.isArray(obj.compat)) {
      throw new AdvancedConfigError("compat must be an object");
    }
    const compatRaw = obj.compat as Record<string, unknown>;
    const compat: AdvancedConfig["compat"] = {};

    if (compatRaw.supportsDeveloperRole !== undefined) {
      if (typeof compatRaw.supportsDeveloperRole !== "boolean")
        throw new AdvancedConfigError("compat.supportsDeveloperRole must be boolean");
      compat.supportsDeveloperRole = compatRaw.supportsDeveloperRole;
    }
    if (compatRaw.supportsReasoningEffort !== undefined) {
      if (typeof compatRaw.supportsReasoningEffort !== "boolean")
        throw new AdvancedConfigError("compat.supportsReasoningEffort must be boolean");
      compat.supportsReasoningEffort = compatRaw.supportsReasoningEffort;
    }
    if (compatRaw.thinkingFormat !== undefined) {
      if (typeof compatRaw.thinkingFormat !== "string" || !VALID_THINKING_FORMATS.includes(compatRaw.thinkingFormat))
        throw new AdvancedConfigError(`compat.thinkingFormat must be one of: ${VALID_THINKING_FORMATS.join(", ")}`);
      compat.thinkingFormat = compatRaw.thinkingFormat;
    }
    if (compatRaw.maxTokensField !== undefined) {
      if (typeof compatRaw.maxTokensField !== "string" || !VALID_MAX_TOKENS_FIELDS.includes(compatRaw.maxTokensField))
        throw new AdvancedConfigError(`compat.maxTokensField must be one of: ${VALID_MAX_TOKENS_FIELDS.join(", ")}`);
      compat.maxTokensField = compatRaw.maxTokensField;
    }
    result.compat = compat;
  }

  // thinkingLevelValue (fish 2026-08-09 simplified: single send-value override)
  if (obj.thinkingLevelValue !== undefined) {
    if (typeof obj.thinkingLevelValue !== "string") {
      throw new AdvancedConfigError("thinkingLevelValue must be a string");
    }
    // Empty string = clear override (treat as absent)
    if (obj.thinkingLevelValue.trim() !== "") {
      result.thinkingLevelValue = obj.thinkingLevelValue.trim();
    }
  }

  // thinkingLevelMap — still accepted for backward-compat / migration reads
  // (UI no longer writes it; buildModelsJson migrates to single-row map)
  if (obj.thinkingLevelMap !== undefined) {
    if (typeof obj.thinkingLevelMap !== "object" || Array.isArray(obj.thinkingLevelMap)) {
      throw new AdvancedConfigError("thinkingLevelMap must be an object");
    }
    const mapRaw = obj.thinkingLevelMap as Record<string, unknown>;
    const map: Record<string, string | null> = {};
    for (const key of Object.keys(mapRaw)) {
      if (!VALID_THINKING_LEVELS.includes(key)) {
        throw new AdvancedConfigError(`thinkingLevelMap key "${key}" is not a valid thinking level`);
      }
      const val = mapRaw[key];
      if (val === null) {
        map[key] = null;
      } else if (typeof val === "string") {
        map[key] = val;
      } else {
        throw new AdvancedConfigError(`thinkingLevelMap["${key}"] must be string or null`);
      }
    }
    result.thinkingLevelMap = map;
  }

  // input
  if (obj.input !== undefined) {
    if (!Array.isArray(obj.input)) {
      throw new AdvancedConfigError("input must be an array");
    }
    const inputs = obj.input as unknown[];
    for (const v of inputs) {
      if (v !== "text" && v !== "image") {
        throw new AdvancedConfigError(`input values must be "text" or "image"`);
      }
    }
    result.input = inputs as ("text" | "image")[];
  }

  // cost
  if (obj.cost !== undefined) {
    if (typeof obj.cost !== "object" || Array.isArray(obj.cost)) {
      throw new AdvancedConfigError("cost must be an object");
    }
    const costRaw = obj.cost as Record<string, unknown>;
    const cost: AdvancedConfig["cost"] = {};
    for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      if (costRaw[field] !== undefined) {
        if (typeof costRaw[field] !== "number" || !Number.isFinite(costRaw[field]) || costRaw[field] < 0) {
          throw new AdvancedConfigError(`cost.${field} must be a non-negative number`);
        }
        cost[field] = costRaw[field];
      }
    }
    result.cost = cost;
  }

  // Must have at least one key
  if (Object.keys(result).length === 0) {
    throw new AdvancedConfigError("advanced_config must contain at least one field (compat/thinkingLevelValue/input/cost)");
  }

  return result;
}

export class AdvancedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvancedConfigError";
  }
}

// ── buildModelsJson ───────────────────────────────────────────────────

const PROVIDER_KEY = "platform";
const API_KEY_ENV = "VULNHUNTER_LLM_API_KEY";

/**
 * Build a complete models.json from a credential.
 *
 * Merge priority (low → high):
 *   pi catalog defaults ← credential scalar fields ← advanced_config overrides
 *
 * The API key is always `$VULNHUNTER_LLM_API_KEY` template — pi resolves
 * $ENV_VAR at runtime, keeping plaintext off disk.
 */
export async function buildModelsJson(
  cred: DecryptedCredentialLike,
  opts?: { apiKeyEnvName?: string },
): Promise<ModelsJsonResult> {
  const apiKeyEnvName = opts?.apiKeyEnvName ?? API_KEY_ENV;
  const api = mapProtoToApi(cred.proto_type);
  const baseUrl = (cred.base_url ?? "").replace(/\/+$/, "");

  // Lookup pi catalog for real field values
  const catalogModel = await lookupCatalogModel(baseUrl, cred.model_id, {
    thinkingFormat: cred.advanced_config?.compat?.thinkingFormat,
  });

  // ── Model entry assembly (merge priority: catalog ← scalar ← advanced) ──
  const modelEntry: Record<string, unknown> = {
    id: cred.model_id,
  };

  // contextWindow: scalar credential > catalog > 200000 fallback (default
  // raised from 128000, fish 2026-08-19)
  const contextWindow =
    cred.context_window_tokens ||
    catalogModel?.contextWindow ||
    200_000;
  modelEntry.contextWindow = contextWindow;

  // input: advanced_config > catalog > ["text"]
  const input =
    cred.advanced_config?.input ||
    catalogModel?.input ||
    ["text"];
  modelEntry.input = input;

  // reasoning: derive from thinking_effort
  const hasThinking =
    !!cred.thinking_effort &&
    cred.thinking_effort !== "off" &&
    cred.thinking_effort !== "none";
  modelEntry.reasoning = hasThinking;

  // maxTokens 不缺省化 (fish 2026-08-19): ALWAYS send, both OpenAI-compatible
  // and Anthropic — three-tier fallback chain, mirroring contextWindow:
  //   credential max_output_tokens > pi catalog real value > 128000.
  // Replaces the retired policies: "OpenAI-compatible sends nothing"
  // (kimi 2026-08-06 — real cause was a too-small hardcoded value, not the
  // field itself; 128000 > thinking budgets) and the anthropic 36864
  // fallback. Reasoning models (glm-5.3 etc.) burn output budget on thinking
  // chains — pi's silent 16384 default starved them (QA 6766220b).
  const maxTokens =
    (cred.max_output_tokens && cred.max_output_tokens > 0 ? cred.max_output_tokens : undefined) ??
    catalogModel?.maxTokens ??
    128_000;
  modelEntry.maxTokens = maxTokens;

  // ── compat ──
  const compat: Record<string, unknown> = {};

  // openai-completions defaults supportsDeveloperRole=false (fish 2026-08-05)
  if (api === "openai-completions") {
    compat.supportsDeveloperRole = false;
  }

  // Merge catalog compat
  if (catalogModel?.compat) {
    Object.assign(compat, catalogModel.compat);
  }

  // Merge advanced_config compat (highest priority)
  if (cred.advanced_config?.compat) {
    Object.assign(compat, cred.advanced_config.compat);
  }

  if (Object.keys(compat).length > 0) {
    modelEntry.compat = compat;
  }

  // ── reasoning + thinkingLevelMap (single-row synthesis, fish 2026-08-09) ──
  // Platform stores one selected level (thinking_effort) + optional send-value
  // override (thinkingLevelValue). Pi still consumes a thinkingLevelMap — we
  // synthesize a one-row map for the selected level only.
  // Migration: if legacy seven-row thinkingLevelMap is present and no
  // thinkingLevelValue, take the row matching thinking_effort as the override.
  if (hasThinking) {
    const effort = cred.thinking_effort;
    let sendValue: string | null | undefined = cred.advanced_config?.thinkingLevelValue;
    if (sendValue === undefined && cred.advanced_config?.thinkingLevelMap) {
      // Legacy map migration: use the current effort's row if present
      if (effort in cred.advanced_config.thinkingLevelMap) {
        sendValue = cred.advanced_config.thinkingLevelMap[effort];
      }
    }
    if (sendValue !== undefined && sendValue !== effort) {
      // Only emit a map when the send value differs from the level word
      // (or is null = "don't send for this level"). Identity override is a no-op.
      modelEntry.thinkingLevelMap = { [effort]: sendValue };
    }
    // Pi rule (models.js:399-400): xhigh/max MUST be explicitly declared in
    // thinkingLevelMap to be selectable — the declaration itself is the switch.
    // Always emit a map row for these two levels even when sendValue === effort.
    const needsDeclaration = effort === "xhigh" || effort === "max";
    if (needsDeclaration && !modelEntry.thinkingLevelMap) {
      modelEntry.thinkingLevelMap = { [effort]: sendValue ?? effort };
    }
  }

  // ── cost ──
  const cost = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    ...catalogModel?.cost,
    ...cred.advanced_config?.cost,
  };
  modelEntry.cost = cost;

  // ── Provider entry ──
  const modelsJson = {
    providers: {
      [PROVIDER_KEY]: {
        api,
        baseUrl,
        apiKey: `$${apiKeyEnvName}`,
        models: [modelEntry],
      },
    },
  };

  return {
    modelsJson,
    childEnv: { [apiKeyEnvName]: cred.api_key },
    providerKey: PROVIDER_KEY,
    modelRef: cred.model_id,
  };
}

// ── Convenience: build for multiple credentials (chat additional models) ──

export interface MultiCredentialItem {
  id: string;
  proto_type: string;
  base_url: string | null;
  model_id: string;
  thinking_effort: string;
  context_window_tokens: number;
  max_output_tokens?: number | null;
  api_key: string;
  advanced_config?: AdvancedConfig | null;
}

/**
 * Build models.json for chat worker: primary credential as "vulnhunter"
 * provider + all additional credentials as "va-<id8>" providers.
 * Each credential gets its own $VH_KEY_<id12> env var template.
 *
 * Returns models.json content + a map of all env vars to inject.
 */
export async function buildModelsJsonMulti(
  primary: MultiCredentialItem,
  additional: MultiCredentialItem[],
): Promise<ModelsJsonResult> {
 const providers: Record<string, unknown> = {};
 const childEnv: Record<string, string> = {};

 // Primary credential → "vulnhunter" provider (bridge convention)
 const primaryEnvName = "VH_LLM_API_KEY";
 const primaryResult = await buildModelsJson(primary, { apiKeyEnvName: primaryEnvName });
 const primaryProvider = (primaryResult.modelsJson as { providers: Record<string, unknown> }).providers[PROVIDER_KEY];
 providers["vulnhunter"] = primaryProvider;
 Object.assign(childEnv, primaryResult.childEnv);

 // Additional credentials → "va-<id8>" providers
 for (const cred of additional) {
   const providerKey = `va-${cred.id.slice(0, 8)}`;
   const apiKeyEnvName = `VH_KEY_${cred.id.replace(/-/g, "_").slice(0, 12).toUpperCase()}`;
   const result = await buildModelsJson(cred, { apiKeyEnvName });
   const provider = (result.modelsJson as { providers: Record<string, unknown> }).providers[PROVIDER_KEY];
   providers[providerKey] = provider;
   Object.assign(childEnv, result.childEnv);
 }

 return {
   modelsJson: { providers },
   childEnv,
   providerKey: "vulnhunter",
   modelRef: primary.model_id,
 };
}

// ── Thinking levels for UI ────────────────────────────────────────────

export const PI_THINKING_LEVELS = VALID_THINKING_LEVELS;
