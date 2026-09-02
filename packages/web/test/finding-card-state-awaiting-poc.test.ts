import { describe, expect, it } from "vitest";
import { EXP_STATE_DISPLAY, resolveExpCardState, showIncompleteBanner } from "../src/features/tasks/components/finding-card-state.js";

/**
 * HALL-35: verify writes exp_status=awaiting-poc for new vulnerability
 * findings; the engine advances it to pending only after a successful PoC.
 * The EXP card must render it as a distinct "waiting for PoC" state and must
 * not flag it as incomplete-pending.
 */
describe("EXP card awaiting-poc state (HALL-35)", () => {
  it("has a display entry for every EXP status including awaiting-poc", () => {
    for (const status of ["pending", "awaiting-poc", "confirmed", "downgraded", "failed", "blocked", "not-needed", "unknown"] as const) {
      expect(EXP_STATE_DISPLAY[status], `${status} must have a display entry`).toBeDefined();
      expect(EXP_STATE_DISPLAY[status].labelKey).toBeTruthy();
      expect(EXP_STATE_DISPLAY[status].helperKey).toBeTruthy();
    }
    expect(EXP_STATE_DISPLAY["awaiting-poc"].labelKey).toBe("awaitingPoc");
  });

  it("resolves awaiting-poc as waiting for PoC while PoC is still pending", () => {
    expect(
      resolveExpCardState({ dynamicEnabled: true, pocStatus: "pending", expStatus: "awaiting-poc" }),
    ).toEqual({ derived: null, status: "awaiting-poc", waitingForPoc: true });
  });

  it("keeps awaiting-poc visible even when poc_status is reproduced (transitional write)", () => {
    expect(
      resolveExpCardState({ dynamicEnabled: true, pocStatus: "reproduced", expStatus: "awaiting-poc" }),
    ).toEqual({ derived: null, status: "awaiting-poc", waitingForPoc: false });
  });

  it("does not override awaiting-poc with the not-enabled or timed-out derived states in a dynamic run", () => {
    expect(
      resolveExpCardState({ dynamicEnabled: true, pocStatus: "pending", expStatus: "awaiting-poc", timedOut: true }),
    ).toEqual({ derived: null, status: "awaiting-poc", waitingForPoc: true });
  });

  it("static runs still show the not_enabled derived state regardless of exp_status", () => {
    expect(
      resolveExpCardState({ dynamicEnabled: false, pocStatus: null, expStatus: "awaiting-poc" }),
    ).toEqual({ derived: "not_enabled", status: "pending", waitingForPoc: false });
  });

  it("awaiting-poc is not an incomplete-pending banner state", () => {
    expect(showIncompleteBanner(true, "awaiting-poc")).toBe(false);
    expect(showIncompleteBanner(true, "pending")).toBe(true);
  });
});
