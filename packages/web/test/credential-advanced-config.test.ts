// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  countCustomized,
  defaultAdvancedConfig,
  parseAdvancedConfig,
  serializeAdvancedConfig,
  validateAdvancedJson,
} from "../src/features/settings/components/CredentialAdvancedConfig.js";

describe("credential advanced_config helpers (fish 2026-08-08 §3.1a)", () => {
  it("default state serializes to null (使用默认配置, sparse persistence)", () => {
    expect(serializeAdvancedConfig(defaultAdvancedConfig())).toBeNull();
    expect(countCustomized(defaultAdvancedConfig())).toBe(0);
  });

  it("sparse serialization keeps only non-default values", () => {
    const s = defaultAdvancedConfig();
    s.thinkingFormat = "zai";
    s.supportsDeveloperRole = false;
    expect(serializeAdvancedConfig(s)).toEqual({
      compat: { thinkingFormat: "zai", supportsDeveloperRole: false },
    });
    expect(countCustomized(s)).toBe(2);
  });

  it("thinkingLevelMap: skip → null, value → string, empty rows dropped", () => {
    const s = defaultAdvancedConfig();
    s.levelMap.off = { value: "nothink", skip: false };
    s.levelMap.minimal = { value: "", skip: true };
    s.levelMap.max = { value: " max ", skip: false }; // trimmed on save
    expect(serializeAdvancedConfig(s)).toEqual({
      thinkingLevelMap: { off: "nothink", minimal: null, max: "max" },
    });
    expect(countCustomized(s)).toBe(3);
  });

  it("input: [text] is default (dropped); [text,image] persists", () => {
    const s = defaultAdvancedConfig();
    s.inputImage = true;
    expect(serializeAdvancedConfig(s)).toEqual({ input: ["text", "image"] });
  });

  it("cost: numeric strings persist as numbers; empty/invalid dropped", () => {
    const s = defaultAdvancedConfig();
    s.costInput = "0.6";
    s.costOutput = "abc"; // invalid → dropped by serializer
    expect(serializeAdvancedConfig(s)).toEqual({ cost: { input: 0.6 } });
  });

  it("parse ↔ serialize roundtrips a fish-shaped zapi-style payload (explicit defaults normalized away)", () => {
    const payload = {
      compat: { supportsDeveloperRole: false, thinkingFormat: "zai", supportsReasoningEffort: true },
      thinkingLevelMap: { off: "nothink", minimal: null, max: "max" },
      cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
    };
    const parsed = parseAdvancedConfig(payload);
    // supportsReasoningEffort: true IS the default — sparse output drops it.
    expect(serializeAdvancedConfig(parsed)).toEqual({
      compat: { supportsDeveloperRole: false, thinkingFormat: "zai" },
      thinkingLevelMap: { off: "nothink", minimal: null, max: "max" },
      cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
    });
  });

  it("parse tolerates null/garbage and falls back to defaults", () => {
    expect(serializeAdvancedConfig(parseAdvancedConfig(null))).toBeNull();
    expect(serializeAdvancedConfig(parseAdvancedConfig("junk"))).toBeNull();
    expect(serializeAdvancedConfig(parseAdvancedConfig({ compat: { thinkingFormat: "bogus" } }))).toBeNull();
  });

  it("validateAdvancedJson accepts a valid document and rejects with precise keys", () => {
    expect(validateAdvancedJson('{"compat":{"thinkingFormat":"zai"}}')).toBeNull();
    expect(validateAdvancedJson("{bad json")?.key).toBe("settings.adv.json.err.syntax");
    expect(validateAdvancedJson('{"nope":1}')?.key).toBe("settings.adv.json.err.unknownKey");
    expect(validateAdvancedJson('{"compat":{"thinkingFormat":"bogus"}}')?.key).toBe(
      "settings.adv.json.err.thinkingFormat",
    );
    expect(validateAdvancedJson('{"thinkingLevelMap":{"off":5}}')?.key).toBe(
      "settings.adv.json.err.mapValue",
    );
    expect(validateAdvancedJson('{"thinkingLevelMap":{"ultra":"x"}}')?.key).toBe(
      "settings.adv.json.err.mapLevel",
    );
    expect(validateAdvancedJson('{"input":["text","video"]}')?.key).toBe(
      "settings.adv.json.err.inputShape",
    );
    expect(validateAdvancedJson('{"cost":{"input":-1}}')?.key).toBe("settings.adv.json.err.costValue");
  });
});
