import { describe, expect, it } from "vitest";
import { coreFieldsChanged, effectiveApiKey } from "../../src/features/settings/credential-core-fields.js";

const existing = {
  proto_type: "openai-completions",
  base_url: "https://api.deepseek.com/v1",
  model_id: "deepseek-chat",
  api_key: "sk-old",
};

describe("coreFieldsChanged (edit gate: core change requires re-verification)", () => {
  it("label-only style edit (all core identical) -> false", () => {
    expect(coreFieldsChanged(existing, { ...existing })).toBe(false);
  });

  it("trailing-slash difference in base_url is NOT a change", () => {
    expect(coreFieldsChanged(existing, { ...existing, base_url: "https://api.deepseek.com/v1/" })).toBe(false);
  });

  it("proto_type change -> true", () => {
    expect(coreFieldsChanged(existing, { ...existing, proto_type: "anthropic-messages" })).toBe(true);
  });

  it("base_url change -> true", () => {
    expect(coreFieldsChanged(existing, { ...existing, base_url: "https://api.openai.com/v1" })).toBe(true);
  });

  it("model_id change -> true", () => {
    expect(coreFieldsChanged(existing, { ...existing, model_id: "deepseek-reasoner" })).toBe(true);
  });

  it("api_key change -> true; blank key (keep stored) -> false", () => {
    expect(coreFieldsChanged(existing, { ...existing, api_key: "sk-new" })).toBe(true);
    expect(coreFieldsChanged(existing, { ...existing, api_key: "" })).toBe(false);
  });

  it("thinking_effort change -> true (fish 2026-08-06: reasoning params need re-verify)", () => {
    expect(coreFieldsChanged(existing, { ...existing, thinking_effort: "high" })).toBe(true);
    expect(coreFieldsChanged(existing, { ...existing, thinking_effort: "off" })).toBe(true);
    expect(coreFieldsChanged(existing, { ...existing, thinking_effort: existing.thinking_effort })).toBe(false);
  });
});

describe("effectiveApiKey", () => {
  it("prefers input key when provided", () => {
    expect(effectiveApiKey(existing, { ...existing, api_key: "sk-new" })).toBe("sk-new");
  });

  it("falls back to stored key when input blank", () => {
    expect(effectiveApiKey(existing, { ...existing, api_key: "" })).toBe("sk-old");
  });
});
