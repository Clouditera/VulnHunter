import { describe, expect, it } from "vitest";
import { isStrongPassword } from "@vulnhunter/shared";

describe("isStrongPassword", () => {
  it("accepts ≥8 with letters and digits", () => {
    expect(isStrongPassword("abcde123")).toBe(true);
    expect(isStrongPassword("Password1")).toBe(true);
  });
  it("rejects short / letter-only / digit-only", () => {
    expect(isStrongPassword("ab12")).toBe(false);
    expect(isStrongPassword("abcdefgh")).toBe(false);
    expect(isStrongPassword("12345678")).toBe(false);
    expect(isStrongPassword("")).toBe(false);
  });
});
