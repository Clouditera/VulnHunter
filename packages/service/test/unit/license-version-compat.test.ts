import { describe, expect, it } from "vitest";
import { isLicenseVersionCompatible } from "../../src/features/license/version-compat.js";

describe("license version compatibility", () => {
  it("allows major ranges", () => {
    expect(isLicenseVersionCompatible("1.x", "1.0.0")).toBe(true);
    expect(isLicenseVersionCompatible("1", "1.1.0")).toBe(true);
    expect(isLicenseVersionCompatible("1.x", "2.0.0")).toBe(false);
  });

  it("allows minor patch ranges", () => {
    expect(isLicenseVersionCompatible("1.0", "1.0.1")).toBe(true);
    expect(isLicenseVersionCompatible("1.0.x", "1.0.9")).toBe(true);
    expect(isLicenseVersionCompatible("1.0", "1.1.0")).toBe(false);
  });

  it("supports exact patch matches", () => {
    expect(isLicenseVersionCompatible("1.0.0", "1.0.0")).toBe(true);
    expect(isLicenseVersionCompatible("1.0.0", "1.0.1")).toBe(false);
  });

  it("rejects missing or invalid ranges", () => {
    expect(isLicenseVersionCompatible(undefined, "1.0.0")).toBe(false);
    expect(isLicenseVersionCompatible("latest", "1.0.0")).toBe(false);
  });
});
