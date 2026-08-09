import { describe, expect, it } from "vitest";
import { scanMetaFromValues, toPositiveInt } from "../../src/features/files/routes.js";

describe("scanMetaFromValues", () => {
  it("persists trimmed audit_focus and positive integer fields", () => {
    expect(
      scanMetaFromValues("  focus on command exec  ", "900", "5"),
    ).toEqual({
      audit_focus: "focus on command exec",
      scan_timeout: 900,
      max_items_per_recon: 5,
    });
  });

  it("persists output_language + vuln_focus (fish 2026-08-09)", () => {
    expect(
      scanMetaFromValues(undefined, undefined, undefined, undefined, undefined, {
        outputLanguage: "en",
        vulnFocus: "  关注 RCE  ",
      }),
    ).toEqual({
      output_language: "en",
      vuln_focus: "关注 RCE",
    });
  });

  it("normalizes output_language aliases and rejects invalid", () => {
    expect(
      scanMetaFromValues(undefined, undefined, undefined, undefined, undefined, {
        outputLanguage: "zh",
      }),
    ).toEqual({ output_language: "zh-CN" });
    expect(() =>
      scanMetaFromValues(undefined, undefined, undefined, undefined, undefined, {
        outputLanguage: "fr",
      }),
    ).toThrow(/invalid output_language/);
  });

  it("omits empty output_language / vuln_focus (engine defaults apply)", () => {
    expect(
      scanMetaFromValues(undefined, undefined, undefined, undefined, undefined, {
        outputLanguage: "  ",
        vulnFocus: "",
      }),
    ).toEqual({});
  });

  it("omits empty / whitespace audit_focus", () => {
    expect(scanMetaFromValues("   ", undefined, undefined)).toEqual({});
    expect(scanMetaFromValues(null, null, null)).toEqual({});
  });

  it("drops non-positive or invalid numeric fields", () => {
    expect(scanMetaFromValues(undefined, "0", "-3")).toEqual({});
    expect(scanMetaFromValues(undefined, "abc", "")).toEqual({});
  });

  it("accepts numeric inputs directly and truncates", () => {
    expect(scanMetaFromValues(undefined, 600, 10)).toEqual({
      scan_timeout: 600,
      max_items_per_recon: 10,
    });
  });
});

describe("toPositiveInt", () => {
  it("parses positive integers from strings", () => {
    expect(toPositiveInt("42")).toBe(42);
    expect(toPositiveInt(" 7 ")).toBe(7);
  });

  it("returns undefined for empty, zero, negative, or invalid", () => {
    expect(toPositiveInt("")).toBeUndefined();
    expect(toPositiveInt(null)).toBeUndefined();
    expect(toPositiveInt(undefined)).toBeUndefined();
    expect(toPositiveInt("0")).toBeUndefined();
    expect(toPositiveInt("-5")).toBeUndefined();
    expect(toPositiveInt("nope")).toBeUndefined();
  });
});
