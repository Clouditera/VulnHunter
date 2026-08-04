import { describe, expect, it } from "vitest";
import { lookupModelMeta } from "../../src/features/settings/pi-model-catalog.js";

describe("pi-model-catalog lookup", () => {
  it("known reasoning model has reasoning=true with thinking levels", () => {
    const meta = lookupModelMeta("o3-mini");
    expect(meta.reasoning).toBe(true);
    expect(meta.thinking_levels.length).toBeGreaterThan(0);
    expect(meta.thinking_levels).not.toEqual(["off"]);
  });

  it("known non-reasoning model has reasoning=false", () => {
    const meta = lookupModelMeta("gpt-4o");
    expect(meta.reasoning).toBe(false);
    expect(meta.thinking_levels).toEqual(["off"]);
  });

  it("unknown model returns empty (no false positives)", () => {
    const meta = lookupModelMeta("totally-bogus-model-xyz");
    expect(meta.reasoning).toBe(false);
    expect(meta.thinking_levels).toEqual([]);
  });
});
