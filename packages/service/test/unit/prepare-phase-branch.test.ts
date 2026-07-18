import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  prepareResult: { project_complete: true, sandbox_type: null as string | null, reason: "complete" as string },
  dynamicEnabled: false,
  events: [] as any[],
  metadataPatches: [] as any[],
  downgradeCalls: [] as string[],
  run: vi.fn(async function (this: any) { return (m as any).prepareResult; }),
}));

vi.mock("../../src/features/workers/prepare-worker.js", () => ({
  isDynamicEnabled: () => m.dynamicEnabled,
  runPrepareWorker: vi.fn(async () => m.prepareResult),
  stopPrepareWorkerByClaim: vi.fn(async () => undefined),
}));
vi.mock("../../src/features/events/event-store.js", () => ({
  appendEvent: vi.fn((taskId: string, event: any) => { m.events.push(event); return { seq: m.events.length, event }; }),
}));
vi.mock("../../src/features/events/ws-live-log.js", () => ({ broadcastEvent: vi.fn() }));
vi.mock("../../src/features/tasks/storage.js", () => ({
  mergeTaskMetadata: vi.fn(async (taskId: string, patch: any) => { m.metadataPatches.push(patch); }),
  downgradeDynamicToggles: vi.fn(async (taskId: string) => { m.downgradeCalls.push(taskId); }),
}));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { TaskScheduler } from "../../src/features/workers/scheduler.js";

const token = "11111111-1111-4111-8111-111111111111";
const baseTask = {
  id: "task-1", credential_id: null, source_meta: {}, started_at: null,
  scheduler_claim: { token, mode: "fresh" },
} as any;

function scheduler(): TaskScheduler {
  return new TaskScheduler({ dataDir: "/tmp", minio: { bucket: "b" } } as any);
}

describe("runPreparePhase branch matrix", () => {
  beforeEach(() => {
    m.events = [];
    m.metadataPatches = [];
    m.downgradeCalls = [];
    m.dynamicEnabled = false;
    m.prepareResult = { project_complete: true, sandbox_type: null, reason: "complete" };
    baseTask.source_meta = {};
  });

  it("complete + dynamic off → proceeds, records result, emits started+completed, no flag/fail", async () => {
    m.dynamicEnabled = false;
    m.prepareResult = { project_complete: true, sandbox_type: null, reason: "complete" };
    await (scheduler() as any).runPreparePhase(baseTask, token, "/tmp/w");
    const types = m.events.map((e) => e.type);
    expect(types).toEqual(["prepare_started", "prepare_completed"]);
    expect(m.events[0].dynamic_enabled).toBe(false);
    expect(m.events[1]).toMatchObject({ project_complete: true, sandbox_type: null, reason: "complete" });
    // metadata recorded the three-field result, no source_incomplete flag
    expect(m.metadataPatches.some((p) => p.prepare)).toBe(true);
    expect(m.metadataPatches.some((p) => p.source_incomplete)).toBe(false);
  });

  it("partial_source + dynamic on → downgrades four keys (persisted + in-memory), continues static", async () => {
    m.dynamicEnabled = true;
    baseTask.source_meta = { dynamic_enabled: true, enable_poc: true, enable_exp: true, enable_chain: true };
    m.prepareResult = { project_complete: false, sandbox_type: null, reason: "partial_source" };
    await (scheduler() as any).runPreparePhase(baseTask, token, "/tmp/w");
    expect(m.metadataPatches.some((p) => p.source_incomplete === true)).toBe(true);
    expect(m.downgradeCalls).toEqual(["task-1"]);
    expect(baseTask.source_meta).toEqual({ dynamic_enabled: false, enable_poc: false, enable_exp: false, enable_chain: false });
    expect(m.events.map((e) => e.type)).toEqual(["prepare_started", "prepare_completed"]);
  });

  it("partial_source + dynamic off → flag only, no downgrade write", async () => {
    m.dynamicEnabled = false;
    m.prepareResult = { project_complete: false, sandbox_type: null, reason: "partial_source" };
    await (scheduler() as any).runPreparePhase(baseTask, token, "/tmp/w");
    expect(m.metadataPatches.some((p) => p.source_incomplete === true)).toBe(true);
    expect(m.downgradeCalls).toEqual([]);
    expect(baseTask.source_meta).toEqual({});
  });

  it("complete + dynamic on + sandbox chosen → proceeds (no throw), records sandbox_type", async () => {
    m.dynamicEnabled = true;
    m.prepareResult = { project_complete: true, sandbox_type: "linux-docker", reason: "complete" };
    await (scheduler() as any).runPreparePhase(baseTask, token, "/tmp/w");
    expect(m.events.map((e) => e.type)).toEqual(["prepare_started", "prepare_completed"]);
    const recorded = m.metadataPatches.find((p) => p.prepare);
    expect(recorded.prepare.sandbox_type).toBe("linux-docker");
    expect(m.metadataPatches.some((p) => p.source_incomplete)).toBe(false);
    expect(m.downgradeCalls).toEqual([]);
  });

  it("complete + dynamic on + no compatible sandbox → O1: throws with reason + remediation, emits prepare_failed", async () => {
    m.dynamicEnabled = true;
    m.prepareResult = { project_complete: true, sandbox_type: null, reason: "no_compatible_sandbox" };
    await expect((scheduler() as any).runPreparePhase(baseTask, token, "/tmp/w")).rejects.toThrow(/未找到兼容的沙箱类型/);
    const types = m.events.map((e) => e.type);
    expect(types).toContain("prepare_failed");
    const failed = m.events.find((e) => e.type === "prepare_failed");
    expect(failed.remediation).toBeTruthy();
  });

  it("dynamic off + no compatible sandbox → proceeds (sandbox_type irrelevant when dynamic off)", async () => {
    m.dynamicEnabled = false;
    m.prepareResult = { project_complete: true, sandbox_type: null, reason: "no_compatible_sandbox" };
    await (scheduler() as any).runPreparePhase(baseTask, token, "/tmp/w");
    expect(m.events.map((e) => e.type)).toEqual(["prepare_started", "prepare_completed"]);
  });
});
