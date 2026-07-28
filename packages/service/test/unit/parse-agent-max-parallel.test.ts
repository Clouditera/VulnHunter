import { describe, expect, it } from "vitest";
import { parseAgentMaxParallel } from "../../src/features/files/routes.js";

describe("parseAgentMaxParallel", () => {
  it("returns undefined when omitted (default 3 downstream)", () => {
    expect(parseAgentMaxParallel(undefined)).toBeUndefined();
    expect(parseAgentMaxParallel(null)).toBeUndefined();
    expect(parseAgentMaxParallel("")).toBeUndefined();
  });

  it("accepts positive integers with no upper bound", () => {
    expect(parseAgentMaxParallel(1)).toBe(1);
    expect(parseAgentMaxParallel(3)).toBe(3);
    expect(parseAgentMaxParallel(10)).toBe(10);
    expect(parseAgentMaxParallel(100)).toBe(100);
    expect(parseAgentMaxParallel("42")).toBe(42);
  });

  it("rejects non-positive or non-integer", () => {
    expect(() => parseAgentMaxParallel(0)).toThrow(/positive integer/);
    expect(() => parseAgentMaxParallel(-1)).toThrow(/positive integer/);
    expect(() => parseAgentMaxParallel(1.5)).toThrow(/positive integer/);
    expect(() => parseAgentMaxParallel("abc")).toThrow(/positive integer/);
  });
});
