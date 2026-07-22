import { beforeEach, describe, expect, it } from "vitest";
import { appendEvent, getEventTotal, clearTaskBuffer } from "../../src/features/events/event-store.js";
import type { LiveLogEvent } from "@vulnhunter/shared";

const ev = (i: number): LiveLogEvent => ({ type: "log", source: "scan", message: `e${i}` } as unknown as LiveLogEvent);

describe("getEventTotal", () => {
  beforeEach(() => clearTaskBuffer("t-total"));

  it("returns 0 for unknown task", () => {
    expect(getEventTotal("no-such-task")).toBe(0);
  });

  it("counts total events even after ring-buffer eviction beyond cap", () => {
    // cap is 1000; append 1200 → buffer holds 1000 but total reflects 1200.
    for (let i = 0; i < 1200; i++) appendEvent("t-total", ev(i));
    expect(getEventTotal("t-total")).toBe(1200);
  });

  it("increments monotonically", () => {
    appendEvent("t-total", ev(1));
    appendEvent("t-total", ev(2));
    expect(getEventTotal("t-total")).toBe(2);
  });
});
