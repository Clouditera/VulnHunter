import { describe, it, expect, beforeEach } from "vitest";
import {
  appendEvent,
  getEventsSince,
  getAllEvents,
  clearTaskBuffer,
} from "../../src/features/events/event-store.js";
import type { ToolCallEvent } from "@vulnagent/shared";

function makeToolCall(tool: string, seq = 0): ToolCallEvent {
  return {
    type: "tool_call",
    source: "scan",
    seq,
    ts: new Date().toISOString(),
    stage: "profiler",
    tool,
    args_summary: "arg",
    duration_ms: 10,
    status: "success",
  };
}

describe("EventStore ring buffer", () => {
  const taskId = "test-task-" + Math.random();

  beforeEach(() => {
    clearTaskBuffer(taskId);
  });

  it("appends events and assigns monotonic seq", () => {
    appendEvent(taskId, makeToolCall("read_file"));
    appendEvent(taskId, makeToolCall("write_file"));

    const events = getAllEvents(taskId);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(0);
    expect(events[1].seq).toBe(1);
  });

  it("getEventsSince returns only events after sinceSeq", () => {
    appendEvent(taskId, makeToolCall("t1")); // seq 0
    appendEvent(taskId, makeToolCall("t2")); // seq 1
    appendEvent(taskId, makeToolCall("t3")); // seq 2

    const since1 = getEventsSince(taskId, 1);
    expect(since1).toHaveLength(1);
    expect((since1[0].event as ToolCallEvent).tool).toBe("t3");
  });

  it("getEventsSince(-1) returns all events", () => {
    appendEvent(taskId, makeToolCall("a"));
    appendEvent(taskId, makeToolCall("b"));

    const all = getEventsSince(taskId, -1);
    expect(all).toHaveLength(2);
  });

  it("returns empty array for unknown task", () => {
    expect(getAllEvents("no-such-task")).toHaveLength(0);
    expect(getEventsSince("no-such-task", 0)).toHaveLength(0);
  });

  it("injects seq into event", () => {
    const entry = appendEvent(taskId, makeToolCall("tool_x"));
    expect(entry.event.seq).toBe(entry.seq);
  });
});
