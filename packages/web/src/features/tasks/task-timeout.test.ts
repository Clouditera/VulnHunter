import { describe, expect, it } from "vitest";
import { effectiveTaskState, isTaskTimedOut } from "./task-timeout.js";

describe("task-timeout helpers", () => {
  it("timeout → timed_out virtual state", () => {
    const t = { state: "completed", completion_reason: "timeout" };
    expect(isTaskTimedOut(t)).toBe(true);
    expect(effectiveTaskState(t)).toBe("timed_out");
  });

  it("natural completed stays completed", () => {
    const t = { state: "completed", completion_reason: "natural" };
    expect(isTaskTimedOut(t)).toBe(false);
    expect(effectiveTaskState(t)).toBe("completed");
  });

  it("missing completion_reason treated as natural", () => {
    const t = { state: "completed", completion_reason: null };
    expect(isTaskTimedOut(t)).toBe(false);
    expect(effectiveTaskState(t)).toBe("completed");
  });
});
