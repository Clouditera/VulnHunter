import { describe, expect, it } from "vitest";
import { generateNumericCode, makeCodeHash, verifyCodeHash } from "../../src/features/auth/email-codes.js";

describe("email code hash", () => {
  it("round-trips hash verification", () => {
    const code = "123456";
    const stored = makeCodeHash(code);
    expect(stored.includes("$")).toBe(true);
    expect(verifyCodeHash(code, stored)).toBe(true);
    expect(verifyCodeHash("000000", stored)).toBe(false);
  });

  it("generates 6-digit codes", () => {
    for (let i = 0; i < 20; i++) {
      const c = generateNumericCode();
      expect(c).toMatch(/^\d{6}$/);
    }
  });
});
