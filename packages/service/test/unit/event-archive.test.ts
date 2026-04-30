import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { appendEvent, clearTaskBuffer } from "../../src/features/events/event-store.js";

const archiveLines = [
  JSON.stringify({ event: "stage_start", ts: "2026-04-30T00:00:00Z", stage: "archived-scan" }),
  JSON.stringify({ event: "stage_done", ts: "2026-04-30T00:00:01Z", stage: "archived-scan", exit_code: 0, duration_ms: 1000 }),
].join("\n");

vi.mock("../../src/infra/config.js", () => ({
  loadConfig: vi.fn(() => ({ dataDir: "/tmp/vh", minio: { bucket: "vulnhunt" } })),
}));

vi.mock("../../src/infra/minio/client.js", () => ({
  getMinio: vi.fn(() => ({
    listObjects: vi.fn(() => Readable.from([{ name: "scan-outputs/task-archive/.youngflow/logs/youngflow.service.jsonl" }])),
    getObject: vi.fn(async () => Readable.from([archiveLines])),
  })),
}));

vi.mock("../../src/infra/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { loadTaskEvents } = await import("../../src/features/events/event-archive.js");

describe("loadTaskEvents", () => {
  afterEach(() => {
    clearTaskBuffer("task-archive");
    clearTaskBuffer("task-running");
  });

  it("merges archived scan events with in-memory events and filters by source", async () => {
    appendEvent("task-archive", {
      type: "task_status",
      source: "report",
      seq: 0,
      ts: "2026-04-30T00:00:02Z",
      status: "running",
    } as any);

    const all = await loadTaskEvents({ taskId: "task-archive", taskState: "completed", source: "all" });
    expect(all).toHaveLength(3);
    expect(all.map((entry) => entry.event.source)).toEqual(["scan", "scan", "report"]);

    const scanOnly = await loadTaskEvents({ taskId: "task-archive", taskState: "completed", source: "scan" });
    expect(scanOnly).toHaveLength(2);
    expect(scanOnly.every((entry) => entry.event.source === "scan")).toBe(true);

    const reportOnly = await loadTaskEvents({ taskId: "task-archive", taskState: "completed", source: "report" });
    expect(reportOnly).toHaveLength(1);
    expect(reportOnly[0].event.source).toBe("report");
  });

  it("uses memory-only fast path for running tasks with source filtering", async () => {
    appendEvent("task-running", { type: "stage_start", source: "scan", seq: 0, ts: "2026-04-30T00:00:00Z", stage: "scan" } as any);
    appendEvent("task-running", { type: "stage_start", source: "poc", seq: 0, ts: "2026-04-30T00:00:01Z", stage: "poc" } as any);

    const events = await loadTaskEvents({ taskId: "task-running", taskState: "running", source: "poc" });
    expect(events).toHaveLength(1);
    expect(events[0].event.source).toBe("poc");
  });
});
