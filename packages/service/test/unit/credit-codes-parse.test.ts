import { describe, expect, it } from "vitest";
import { parseCreditCodeImport } from "../../src/features/admin/credit-codes-storage.js";

describe("parseCreditCodeImport", () => {
  it("trims, drops empties, dedupes batch", () => {
    const r = parseCreditCodeImport("  aaa  \n\nbbb\naaa\nccc\n");
    expect(r.codes).toEqual(["aaa", "bbb", "ccc"]);
    expect(r.invalid).toBe(0);
  });

  it("flags whitespace-in-code and overlong as invalid (≤5 samples)", () => {
    const long = "x".repeat(129);
    const r = parseCreditCodeImport(`good\nbad code\n${long}\nok2`);
    expect(r.codes).toEqual(["good", "ok2"]);
    expect(r.invalid).toBe(2);
    expect(r.invalid_samples.length).toBe(2);
  });

  it("rejects oversized payload", () => {
    const big = "a\n".repeat(200) + "x".repeat(256 * 1024);
    expect(() => parseCreditCodeImport(big)).toThrow("import_too_large");
  });
});
