import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDynamicToggles } from "../../src/features/tasks/dynamic-toggles.js";
import { scanMetaFromValues } from "../../src/features/files/routes.js";

describe("resolveDynamicToggles (B3 single mapping)", () => {
  it("both off → pure static, no fields", () => {
    expect(resolveDynamicToggles({})).toEqual({});
    expect(resolveDynamicToggles({ enableDynamicVerify: false, enableDynamicExploit: false })).toEqual({});
    expect(resolveDynamicToggles({ enableDynamicVerify: "false" })).toEqual({});
  });

  it("verify on → enable_poc + enable_exp + dynamic_enabled", () => {
    expect(resolveDynamicToggles({ enableDynamicVerify: true })).toEqual({
      enable_poc: true, enable_exp: true, dynamic_enabled: true,
    });
    expect(resolveDynamicToggles({ enableDynamicVerify: "true" })).toEqual({
      enable_poc: true, enable_exp: true, dynamic_enabled: true,
    });
  });

  it("verify + exploit on → adds enable_chain", () => {
    expect(resolveDynamicToggles({ enableDynamicVerify: true, enableDynamicExploit: true })).toEqual({
      enable_poc: true, enable_exp: true, enable_chain: true, dynamic_enabled: true,
    });
  });

  it("exploit without verify → throws (callers return 400)", () => {
    expect(() => resolveDynamicToggles({ enableDynamicExploit: true })).toThrow(/动态验证/);
    expect(() => resolveDynamicToggles({ enableDynamicVerify: false, enableDynamicExploit: true })).toThrow();
  });
});

describe("scanMetaFromValues dynamic switches", () => {
  it("writes the toggle meta alongside scan_timeout/timeout_mode (enterprise)", () => {
    const meta = scanMetaFromValues(undefined, undefined, undefined, "auto", {
      enableDynamicVerify: true, enableDynamicExploit: true,
    }, undefined, "enterprise");
    expect(meta).toMatchObject({
      enable_poc: true, enable_exp: true, enable_chain: true, dynamic_enabled: true,
      scan_timeout: 72 * 3600, timeout_mode: "auto",
    });
  });

  it("rejects exploit-without-verify (enterprise)", () => {
    expect(() => scanMetaFromValues(undefined, undefined, undefined, undefined, {
      enableDynamicVerify: false, enableDynamicExploit: true,
    }, undefined, "enterprise")).toThrow();
  });

  it("community silently ignores dynamic switches (static-only meta)", () => {
    const meta = scanMetaFromValues(undefined, undefined, undefined, "auto", {
      enableDynamicVerify: true, enableDynamicExploit: true,
    }, undefined, "community");
    expect(meta).not.toHaveProperty("enable_poc");
    expect(meta).not.toHaveProperty("enable_exp");
    expect(meta).not.toHaveProperty("enable_chain");
    expect(meta).not.toHaveProperty("dynamic_enabled");
    expect(meta.timeout_mode).toBe("auto"); // other fields unaffected
  });

  it("static (no switches) writes no enable/dynamic fields", () => {
    const meta = scanMetaFromValues("focus", 600, undefined, undefined);
    expect(meta).not.toHaveProperty("enable_poc");
    expect(meta).not.toHaveProperty("dynamic_enabled");
  });
});

describe("module NOTE reflects the engine consumption reality (S2)", () => {
  it("documents enable_* consumption via dynamic.yaml instead of claiming the engine ignores them", () => {
    const text = readFileSync(
      join(import.meta.dirname, "../../src/features/tasks/dynamic-toggles.ts"),
      "utf8",
    );
    expect(text).not.toContain("does not yet consume");
    expect(text).toMatch(/dynamic\.yaml/);
  });
});
