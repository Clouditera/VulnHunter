import { describe, it, expect } from "vitest";
import { translateYoungflowEvent } from "../../src/features/events/event-tail.js";

describe("translateYoungflowEvent", () => {
  const source = "scan";

  it("translates flow_end with no failures as completed/info", () => {
    const raw = {
      event: "flow_end",
      ts: "2026-04-29T00:00:00Z",
      stages_total: 90,
      stages_completed: 90,
      stages_failed: 0,
    };
    const result = translateYoungflowEvent(raw, source) as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect(result.type).toBe("task_status");
    expect(result.status).toBe("completed");
    expect(result.severity).toBe("info");
    expect(result.reason).toBeUndefined();
    expect(result.stages_failed).toBe(0);
    expect(result.stages_completed).toBe(90);
    expect(result.stages_total).toBe(90);
  });

  it("translates flow_end with partial failures as completed/warning", () => {
    const raw = {
      event: "flow_end",
      ts: "2026-04-29T00:00:00Z",
      stages_total: 90,
      stages_completed: 64,
      stages_failed: 26,
    };
    const result = translateYoungflowEvent(raw, source) as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect(result.type).toBe("task_status");
    expect(result.status).toBe("completed");
    expect(result.severity).toBe("warning");
    expect(result.reason).toBe("completed with 26 stage failure(s)");
    expect(result.stages_failed).toBe(26);
    expect(result.stages_completed).toBe(64);
    expect(result.stages_total).toBe(90);
  });

  it("translates flow_end with missing counts gracefully", () => {
    const raw = {
      event: "flow_end",
      ts: "2026-04-29T00:00:00Z",
    };
    const result = translateYoungflowEvent(raw, source) as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect(result.status).toBe("completed");
    expect(result.severity).toBe("info");
    expect(result.stages_failed).toBe(0);
  });

  it("translates flow_start as running", () => {
    const raw = { event: "flow_start", ts: "2026-04-29T00:00:00Z" };
    const result = translateYoungflowEvent(raw, source) as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect(result.type).toBe("task_status");
    expect(result.status).toBe("running");
  });

  it("returns null for unknown events", () => {
    const raw = { event: "checkpoint_save", ts: "2026-04-29T00:00:00Z" };
    expect(translateYoungflowEvent(raw, source)).toBeNull();
  });

  it("translates stage_start correctly", () => {
    const raw = { event: "stage_start", ts: "2026-04-29T00:00:00Z", stage: "analyzer-1" };
    const result = translateYoungflowEvent(raw, source) as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect(result.type).toBe("stage_start");
    expect(result.stage).toBe("analyzer-1");
  });

  it("translates stage_done with error exit code", () => {
    const raw = { event: "stage_done", ts: "2026-04-29T00:00:00Z", stage: "analyzer-1", exit_code: 3, duration_ms: 5000 };
    const result = translateYoungflowEvent(raw, source) as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect(result.type).toBe("stage_end");
    expect(result.status).toBe("error");
  });
});
