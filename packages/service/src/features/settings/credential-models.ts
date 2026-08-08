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
): Promise<CatalogModel | null> {
  const catalog = await loadCatalog();
  if (!catalog || catalog.length === 0) return null;

  const normalizedBase = baseUrl.toLowerCase().replace(/\/+$/, "");

  // Try matching by baseUrl prefix (most reliable)
  for (const provider of catalog) {
    if (!provider.baseUrlPrefix || !normalizedBase.includes(provider.baseUrlPrefix.replace(/\/+$/, ""))) continue;
    const match = provider.models.find((m) => m.id === modelId);
    if (match) return match;
  }

  // Fallback: match by model id across all providers
  for (const provider of catalog) {
    const match = provider.models.find((m) => m.id === modelId);
    if (match) return match;
  }

  return null;
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

  // thinkingLevelMap
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
    // Ensure all seven keys exist (fill missing with undefined → omit)
    for (const level of VALID_THINKING_LEVELS) {
      if (level in mapRaw) {
        map[level] = mapRaw[level] as string | null;
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
    throw new AdvancedConfigError("advanced_config must contain at least one field (compat/thinkingLevelMap/input/cost)");
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
  const catalogModel = await lookupCatalogModel(baseUrl, cred.model_id);

  // ── Model entry assembly (merge priority: catalog ← scalar ← advanced) ──
  const modelEntry: Record<string, unknown> = {
    id: cred.model_id,
  };

  // contextWindow: scalar credential > catalog > 128000 fallback
  const contextWindow =
    cred.context_window_tokens ||
    catalogModel?.contextWindow ||
    128_000;
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

  // maxTokens: catalog real value; anthropic requires it (API contract)
  // fish 2026-08-06: OpenAI-compatible APIs do NOT carry maxTokens (kimi
  // thinking-budget 400 case). Only set from catalog or advanced_config.
  // Anthropic-messages always needs it: catalog value or 36864 fallback.
  if (api === "anthropic-messages") {
    modelEntry.maxTokens = catalogModel?.maxTokens ?? 36_864;
  }
  // For OpenAI-compatible: do NOT set maxTokens unless advanced_config explicitly provides one
  // (via the thinkingLevelMap/compat path, not directly — maxTokens is a model-level field)

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

  // ── reasoning + thinkingLevelMap ──
  if (hasThinking && cred.advanced_config?.thinkingLevelMap) {
    // Include the thinkingLevelMap in the model entry — pi translates at request time
    modelEntry.thinkingLevelMap = cred.advanced_config.thinkingLevelMap;
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

export async function buildModelsJsonMulti(
  primary: DecryptedCredentialLike,
  additional: DecryptedCredentialLike[],
): Promise<ModelsJsonResult> {
  const primaryResult = await buildModelsJson(primary);

  // Extend providers with additional credentials
  const providers = (primaryResult.modelsJson as { providers: Record<string, unknown> }).providers;

  for (let i = 0; i < additional.length; i++) {
    const cred = additional[i];
    const singleResult = await buildModelsJson(cred);
    const providerKey = `va-${i}`;
    const singleProviders = (singleResult.modelsJson as { providers: Record<string, unknown> }).providers;
    providers[providerKey] = singleProviders[PROVIDER_KEY];

    // Merge child env keys (each credential gets its own env key)
    const envKey = `${API_KEY_ENV}_${i}`;
    (providers[providerKey] as Record<string, unknown>).apiKey = `$${envKey}`;
    (primaryResult.childEnv as Record<string, string>)[envKey] = cred.api_key;
  }

  return {
    ...primaryResult,
    modelsJson: { providers },
  };
}

// ── Thinking levels for UI ────────────────────────────────────────────

export const PI_THINKING_LEVELS = VALID_THINKING_LEVELS;
