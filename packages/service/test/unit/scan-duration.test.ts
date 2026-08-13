import { describe, expect, it } from "vitest";
import {
  computeScanDeadlineAt,
  isScanDeadlineStuck,
  resolveScanDuration,
  SCAN_FALLBACK_MARGIN_S,
  SCAN_TIMEOUT_AUTO_S,
  SCAN_TIMEOUT_DEFAULT_CUSTOM_S,
  SCAN_TIMEOUT_MAX_S,
  SCAN_TIMEOUT_MIN_S,
} from "../../src/features/tasks/scan-duration.js";

describe("H3 scan-duration two-tier semantics", () => {
  it("auto mode forces the fixed 72h ceiling and ignores any user value", () => {
    expect(resolveScanDuration("auto", undefined)).toEqual({ scan_timeout: SCAN_TIMEOUT_AUTO_S, timeout_mode: "auto" });
    expect(resolveScanDuration("auto", 60)).toEqual({ scan_timeout: SCAN_TIMEOUT_AUTO_S, timeout_mode: "auto" });
    expect(resolveScanDuration("auto", "999999")).toEqual({ scan_timeout: SCAN_TIMEOUT_AUTO_S, timeout_mode: "auto" });
    expect(SCAN_TIMEOUT_AUTO_S).toBe(72 * 3600);
  });

  it("custom mode defaults to 10h when no value given", () => {
    expect(resolveScanDuration("custom", undefined)).toEqual({ scan_timeout: SCAN_TIMEOUT_DEFAULT_CUSTOM_S, timeout_mode: "custom" });
    expect(SCAN_TIMEOUT_DEFAULT_CUSTOM_S).toBe(10 * 3600);
  });

  it("custom mode accepts values within [30min, 72h]", () => {
    expect(resolveScanDuration("custom", SCAN_TIMEOUT_MIN_S)).toEqual({ scan_timeout: SCAN_TIMEOUT_MIN_S, timeout_mode: "custom" });
    expect(resolveScanDuration("custom", SCAN_TIMEOUT_MAX_S)).toEqual({ scan_timeout: SCAN_TIMEOUT_MAX_S, timeout_mode: "custom" });
    expect(resolveScanDuration("custom", 3600)).toEqual({ scan_timeout: 3600, timeout_mode: "custom" });
    expect(resolveScanDuration("custom", "1800")).toEqual({ scan_timeout: 1800, timeout_mode: "custom" });
  });

  it("custom mode rejects out-of-range and invalid values", () => {
    expect(() => resolveScanDuration("custom", SCAN_TIMEOUT_MIN_S - 1)).toThrow();
    // fish 2026-08-13: no upper bound on custom scan duration
    expect(() => resolveScanDuration("custom", SCAN_TIMEOUT_MAX_S + 1)).not.toThrow();
    expect(() => resolveScanDuration("custom", 0)).not.toThrow(); // 0/invalid → default
    expect(() => resolveScanDuration("custom", "abc")).not.toThrow(); // invalid → default
  });

  it("legacy clients (no mode) are treated as custom, backward compatible", () => {
    expect(resolveScanDuration(undefined, 3600)).toEqual({ scan_timeout: 3600, timeout_mode: "custom" });
    expect(resolveScanDuration(null, undefined)).toEqual({ scan_timeout: SCAN_TIMEOUT_DEFAULT_CUSTOM_S, timeout_mode: "custom" });
    expect(resolveScanDuration(undefined, undefined)).toEqual({ scan_timeout: SCAN_TIMEOUT_DEFAULT_CUSTOM_S, timeout_mode: "custom" });
  });

  it("computeScanDeadlineAt adds seconds to the start time", () => {
    const start = new Date("2026-07-17T00:00:00.000Z");
    expect(computeScanDeadlineAt(3600, start)).toBe("2026-07-17T01:00:00.000Z");
    expect(computeScanDeadlineAt(SCAN_TIMEOUT_AUTO_S, start)).toBe("2026-07-20T00:00:00.000Z");
  });

  it("isScanDeadlineStuck only fires past deadline + fallback margin", () => {
    const deadline = "2026-07-17T00:00:00.000Z";
    const deadlineMs = Date.parse(deadline);
    // before deadline: not stuck
    expect(isScanDeadlineStuck(deadline, new Date(deadlineMs - 1000))).toBe(false);
    // past deadline but inside the 720s self-finalize window: NOT stuck (form B forbidden)
    expect(isScanDeadlineStuck(deadline, new Date(deadlineMs + 1000))).toBe(false);
    expect(isScanDeadlineStuck(deadline, new Date(deadlineMs + SCAN_FALLBACK_MARGIN_S * 1000 - 1000))).toBe(false);
    // past deadline + margin: stuck
    expect(isScanDeadlineStuck(deadline, new Date(deadlineMs + SCAN_FALLBACK_MARGIN_S * 1000 + 1))).toBe(true);
    expect(isScanDeadlineStuck(deadline, new Date(deadlineMs + 800 * 1000))).toBe(true);
    // no/garbage deadline: never stuck (no platform clock recorded)
    expect(isScanDeadlineStuck(undefined)).toBe(false);
    expect(isScanDeadlineStuck(null)).toBe(false);
    expect(isScanDeadlineStuck("not-a-date")).toBe(false);
  });
});
