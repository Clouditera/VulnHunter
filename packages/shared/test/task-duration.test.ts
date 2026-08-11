import { describe, expect, it } from "vitest";
import { displayedScanDurationMs } from "../src/domain/task.js";

describe("displayedScanDurationMs", () => {
  it("prefers the accumulated duration across continuation segments", () => {
    expect(displayedScanDurationMs({ total_duration_ms: 18_000, duration_ms: 5_000 })).toBe(18_000);
  });

  it("falls back to the last segment for legacy tasks", () => {
    expect(displayedScanDurationMs({ total_duration_ms: 0, duration_ms: 5_000 })).toBe(5_000);
    expect(displayedScanDurationMs({ total_duration_ms: null, duration_ms: 5_000 })).toBe(5_000);
  });

  it("coerces BIGINT strings before selecting a duration", () => {
    expect(displayedScanDurationMs({ total_duration_ms: "18000", duration_ms: "5000" })).toBe(
      18_000,
    );
  });

  it("rejects invalid and negative duration values", () => {
    expect(displayedScanDurationMs({ total_duration_ms: "invalid", duration_ms: "5000" })).toBe(
      5_000,
    );
    expect(displayedScanDurationMs({ total_duration_ms: -1, duration_ms: -2 })).toBeNull();
  });
});
