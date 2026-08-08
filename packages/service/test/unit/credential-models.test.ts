import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildModelsJson,
  validateAdvancedConfig,
  mapProtoToApi,
  AdvancedConfigError,
  PI_THINKING_LEVELS,
  type AdvancedConfig,
  type DecryptedCredentialLike,
} from "../../src/features/settings/credential-models.js";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeCred(overrides: Partial<DecryptedCredentialLike> = {}): DecryptedCredentialLike {
  return {
    proto_type: "openai-completions",
    base_url: "https://api.openai.com/v1",
    model_id: "gpt-4o",
    thinking_effort: "off",
    context_window_tokens: 128000,
    api_key: "sk-test-key-12345",
    advanced_config: null,
    ...overrides,
  };
}

const ZAI_ADVANCED_CONFIG: AdvancedConfig = {
  compat: {
    thinkingFormat: "zai",
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
  },
  thinkingLevelMap: {
    off: "nothink",
    minimal: null, // "don't send" for this level
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: "max",
  },
  input: ["text", "image"],
  cost: { input: 0.5, output: 2.0, cacheRead: 0.1, cacheWrite: 0.5 },
};

// ── Tests ─────────────────────────────────────────────────────────────

describe("mapProtoToApi", () => {
  it("maps anthropic variants to anthropic-messages", () => {
    expect(mapProtoToApi("anthropic")).toBe("anthropic-messages");
    expect(mapProtoToApi("anthropic-messages")).toBe("anthropic-messages");
  });

  it("maps openai-responses", () => {
    expect(mapProtoToApi("openai-responses")).toBe("openai-responses");
  });

  it("defaults to openai-completions", () => {
    expect(mapProtoToApi("openai")).toBe("openai-completions");
    expect(mapProtoToApi("custom")).toBe("openai-completions");
  });
});

describe("validateAdvancedConfig", () => {
  it("returns null for null/undefined", () => {
    expect(validateAdvancedConfig(null)).toBeNull();
    expect(validateAdvancedConfig(undefined)).toBeNull();
  });

  it("rejects non-object", () => {
    expect(() => validateAdvancedConfig("string")).toThrow(AdvancedConfigError);
    expect(() => validateAdvancedConfig([])).toThrow(AdvancedConfigError);
    expect(() => validateAdvancedConfig(42)).toThrow(AdvancedConfigError);
  });

  it("rejects empty object", () => {
    expect(() => validateAdvancedConfig({})).toThrow(/at least one field/);
  });

  it("accepts valid zai config", () => {
    const result = validateAdvancedConfig(ZAI_ADVANCED_CONFIG);
    expect(result).not.toBeNull();
    expect(result!.compat?.thinkingFormat).toBe("zai");
    expect(result!.thinkingLevelMap?.off).toBe("nothink");
    expect(result!.thinkingLevelMap?.minimal).toBeNull();
    expect(result!.input).toEqual(["text", "image"]);
    expect(result!.cost?.input).toBe(0.5);
  });

  it("rejects invalid thinkingFormat", () => {
    expect(() => validateAdvancedConfig({ compat: { thinkingFormat: "bogus" } })).toThrow(AdvancedConfigError);
  });

  it("rejects invalid maxTokensField", () => {
    expect(() => validateAdvancedConfig({ compat: { maxTokensField: "max_stuff" } })).toThrow(AdvancedConfigError);
  });

  it("rejects invalid thinkingLevelMap key", () => {
    expect(() => validateAdvancedConfig({ thinkingLevelMap: { bogus: "value" } })).toThrow(AdvancedConfigError);
  });

  it("rejects non-string/non-null thinkingLevelMap value", () => {
    expect(() => validateAdvancedConfig({ thinkingLevelMap: { high: 42 } })).toThrow(AdvancedConfigError);
  });

  it("rejects non-boolean compat fields", () => {
    expect(() => validateAdvancedConfig({ compat: { supportsDeveloperRole: "yes" } })).toThrow(AdvancedConfigError);
  });

  it("rejects negative cost", () => {
    expect(() => validateAdvancedConfig({ cost: { input: -1 } })).toThrow(AdvancedConfigError);
  });

  it("rejects invalid input values", () => {
    expect(() => validateAdvancedConfig({ input: ["text", "audio"] })).toThrow(AdvancedConfigError);
  });

  it("accepts partial advanced_config (only compat)", () => {
    const result = validateAdvancedConfig({ compat: { thinkingFormat: "deepseek" } });
    expect(result?.compat?.thinkingFormat).toBe("deepseek");
    expect(result?.thinkingLevelMap).toBeUndefined();
  });
});

describe("PI_THINKING_LEVELS", () => {
  it("has seven levels", () => {
    expect(PI_THINKING_LEVELS).toHaveLength(7);
    expect(PI_THINKING_LEVELS).toContain("off");
    expect(PI_THINKING_LEVELS).toContain("max");
  });
});

describe("buildModelsJson", () => {
  it("produces $ENV_VAR template for apiKey (no plaintext)", async () => {
    const result = await buildModelsJson(makeCred({ api_key: "sk-secret-123" }));
    const json = result.modelsJson as any;
    expect(json.providers.platform.apiKey).toBe("$VULNHUNTER_LLM_API_KEY");
    expect(JSON.stringify(json)).not.toContain("sk-secret-123");
  });

  it("child env carries the real key", async () => {
    const result = await buildModelsJson(makeCred({ api_key: "sk-secret-123" }));
    expect(result.childEnv.VULNHUNTER_LLM_API_KEY).toBe("sk-secret-123");
  });

  it("strips trailing slash from baseUrl", async () => {
    const result = await buildModelsJson(makeCred({ base_url: "https://api.example.com/v1/" }));
    const json = result.modelsJson as any;
    expect(json.providers.platform.baseUrl).toBe("https://api.example.com/v1");
  });

  it("sets contextWindow from credential scalar", async () => {
    const result = await buildModelsJson(makeCred({ context_window_tokens: 200000 }));
    const json = result.modelsJson as any;
    expect(json.providers.platform.models[0].contextWindow).toBe(200000);
  });

  it("openai-completions gets supportsDeveloperRole=false", async () => {
    const result = await buildModelsJson(makeCred());
    const model = (result.modelsJson as any).providers.platform.models[0];
    expect(model.compat?.supportsDeveloperRole).toBe(false);
  });

  it("anthropic-messages gets maxTokens", async () => {
    const result = await buildModelsJson(makeCred({
      proto_type: "anthropic-messages",
      base_url: "https://api.anthropic.com",
      model_id: "claude-sonnet-4-20250514",
    }));
    const model = (result.modelsJson as any).providers.platform.models[0];
    expect(model.maxTokens).toBeDefined();
    expect(typeof model.maxTokens).toBe("number");
  });

  it("openai-completions does NOT get maxTokens by default", async () => {
    const result = await buildModelsJson(makeCred());
    const model = (result.modelsJson as any).providers.platform.models[0];
    expect(model.maxTokens).toBeUndefined();
  });

  it("reasoning is true when thinking_effort is set", async () => {
    const result = await buildModelsJson(makeCred({ thinking_effort: "high" }));
    const model = (result.modelsJson as any).providers.platform.models[0];
    expect(model.reasoning).toBe(true);
  });

  it("reasoning is false when thinking_effort is off", async () => {
    const result = await buildModelsJson(makeCred({ thinking_effort: "off" }));
    const model = (result.modelsJson as any).providers.platform.models[0];
    expect(model.reasoning).toBe(false);
  });

  it("advanced_config compat overrides default supportsDeveloperRole", async () => {
    const result = await buildModelsJson(makeCred({
      advanced_config: { compat: { supportsDeveloperRole: true } },
    }));
    const model = (result.modelsJson as any).providers.platform.models[0];
    expect(model.compat.supportsDeveloperRole).toBe(true); // overridden from false
  });

  it("advanced_config thinkingLevelMap included when reasoning enabled", async () => {
    const result = await buildModelsJson(makeCred({
      thinking_effort: "high",
      advanced_config: ZAI_ADVANCED_CONFIG,
    }));
    const model = (result.modelsJson as any).providers.platform.models[0];
    expect(model.thinkingLevelMap).toBeDefined();
    expect(model.thinkingLevelMap.off).toBe("nothink");
    expect(model.thinkingLevelMap.max).toBe("max");
  });

  it("advanced_config thinkingLevelMap NOT included when reasoning disabled", async () => {
    const result = await buildModelsJson(makeCred({
      thinking_effort: "off",
      advanced_config: ZAI_ADVANCED_CONFIG,
    }));
    const model = (result.modelsJson as any).providers.platform.models[0];
    expect(model.thinkingLevelMap).toBeUndefined();
  });

  it("advanced_config input overrides default", async () => {
    const result = await buildModelsJson(makeCred({
      advanced_config: { input: ["text", "image"] },
    }));
    const model = (result.modelsJson as any).providers.platform.models[0];
    expect(model.input).toEqual(["text", "image"]);
  });

  it("advanced_config cost merges with defaults", async () => {
    const result = await buildModelsJson(makeCred({
      advanced_config: { cost: { input: 1.5, output: 6.0 } },
    }));
    const model = (result.modelsJson as any).providers.platform.models[0];
    expect(model.cost.input).toBe(1.5);
    expect(model.cost.output).toBe(6.0);
    // Missing fields default to 0 (catalog may have values for known models)
    expect(typeof model.cost.cacheRead).toBe("number");
    expect(typeof model.cost.cacheWrite).toBe("number");
  });

  it("falls back to 128000 contextWindow when scalar is 0 and catalog misses", async () => {
    const result = await buildModelsJson(makeCred({
      model_id: "nonexistent-model-xyz",
      context_window_tokens: 0,
    }));
    const model = (result.modelsJson as any).providers.platform.models[0];
    expect(model.contextWindow).toBe(128000);
  });

  it("provider key is 'platform' and modelRef is the model id", async () => {
    const result = await buildModelsJson(makeCred({ model_id: "gpt-4o" }));
    expect(result.providerKey).toBe("platform");
    expect(result.modelRef).toBe("gpt-4o");
  });

  it("zai advanced config full integration (fish's zapi fixture)", async () => {
    const cred = makeCred({
      base_url: "https://open.bigmodel.cn/api/paas/v4",
      model_id: "glm-4.6",
      thinking_effort: "high",
      advanced_config: ZAI_ADVANCED_CONFIG,
    });
    const result = await buildModelsJson(cred);
    const model = (result.modelsJson as any).providers.platform.models[0];

    expect(model.compat.thinkingFormat).toBe("zai");
    expect(model.compat.supportsDeveloperRole).toBe(true);
    expect(model.compat.supportsReasoningEffort).toBe(true);
    expect(model.reasoning).toBe(true);
    expect(model.thinkingLevelMap.off).toBe("nothink");
    expect(model.thinkingLevelMap.max).toBe("max");
    expect(model.thinkingLevelMap.minimal).toBeNull();
    expect(model.input).toEqual(["text", "image"]);
    expect(model.cost.input).toBe(0.5);
    // No plaintext key anywhere
    expect(JSON.stringify(result.modelsJson)).not.toContain("sk-");
  });

  it("apiKeyEnvName parameter customizes the $ENV_VAR template (chat path)", async () => {
    const customEnvName = "VH_KEY_ABC123DEF456";
    const result = await buildModelsJson(makeCred({ api_key: "sk-secret-123" }), {
      apiKeyEnvName: customEnvName,
    });
    const json = result.modelsJson as any;
    expect(json.providers.platform.apiKey).toBe(`$${customEnvName}`);
    expect(result.childEnv[customEnvName]).toBe("sk-secret-123");
    // Default name is NOT used
    expect(result.childEnv.VULNHUNTER_LLM_API_KEY).toBeUndefined();
  });

  it("apiKeyEnvName: the $VAR in models.json matches what bridge injects at startup (architect fix)", async () => {
    // Simulate the bridge's VH_KEY_<id> naming convention
    const credId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const expectedEnvName = `VH_KEY_${credId.replace(/-/g, "_").slice(0, 12).toUpperCase()}`;
    const result = await buildModelsJson(makeCred({ api_key: "sk-test" }), {
      apiKeyEnvName: expectedEnvName,
    });
    const json = result.modelsJson as any;
    // The $VAR referenced in models.json MUST match the bridge's injection name
    expect(json.providers.platform.apiKey).toBe(`$${expectedEnvName}`);
    expect(expectedEnvName).toMatch(/^VH_KEY_[A-Z0-9_]+$/);
  });

  it("keyless credential (empty api_key) produces no plaintext leak", async () => {
    const result = await buildModelsJson(makeCred({ api_key: "" }));
    const json = result.modelsJson as any;
    // Even with empty key, the template is still $VULNHUNTER_LLM_API_KEY
    expect(json.providers.platform.apiKey).toBe("$VULNHUNTER_LLM_API_KEY");
    expect(result.childEnv.VULNHUNTER_LLM_API_KEY).toBe("");
    // No sk- pattern in the output
    expect(JSON.stringify(json)).not.toMatch(/sk-[a-zA-Z0-9]{5,}/);
  });

  it("catalog affinity: same model id, prefers provider with matching thinkingFormat", async () => {
    // glm-5.2 exists in multiple providers (e.g. opencode vs zai).
    // With advanced_config thinkingFormat=zai, the zai provider's entry
    // (which has supportsReasoningEffort=true) should be preferred.
    const result = await buildModelsJson(makeCred({
      model_id: "glm-5.2",
      thinking_effort: "high",
      advanced_config: { compat: { thinkingFormat: "zai" } },
    }));
    const model = (result.modelsJson as any).providers.platform.models[0];
    // If the zai provider was matched, its catalog compat should include
    // thinkingFormat=zai (merged from catalog, not just from advanced_config)
    expect(model.compat.thinkingFormat).toBe("zai");
  });
});
