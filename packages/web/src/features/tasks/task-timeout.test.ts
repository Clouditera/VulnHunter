import { describe, expect, it } from "vitest";
import {
  effectiveTaskState,
  isTaskIncomplete,
  isTaskTimedOut,
  isTaskUnfinished,
} from "./task-timeout.js";

describe("task-timeout helpers (fish 2026-08-09 soft gate)", () => {
  it("timeout → timed_out virtual state", () => {
    const t = { state: "completed", completion_reason: "timeout" };
    expect(isTaskTimedOut(t)).toBe(true);
    expect(isTaskIncomplete(t)).toBe(false);
    expect(isTaskUnfinished(t)).toBe(true);
    expect(effectiveTaskState(t)).toBe("timed_out");
  });

  it("incomplete → incomplete virtual state (yellow family)", () => {
    const t = { state: "completed", completion_reason: "incomplete" };
    expect(isTaskIncomplete(t)).toBe(true);
    expect(isTaskTimedOut(t)).toBe(false);
    expect(isTaskUnfinished(t)).toBe(true);
    expect(effectiveTaskState(t)).toBe("incomplete");
  });

  it("natural completed stays completed", () => {
    const t = { state: "completed", completion_reason: "natural" };
    expect(isTaskUnfinished(t)).toBe(false);
    expect(effectiveTaskState(t)).toBe("completed");
  });

  it("failed is not unfinished", () => {
    const t = { state: "failed", completion_reason: null };
    expect(isTaskUnfinished(t)).toBe(false);
    expect(effectiveTaskState(t)).toBe("failed");
  });
});
