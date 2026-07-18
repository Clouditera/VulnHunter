import { beforeEach, describe, expect, it, vi } from "vitest";

let selectResult: { instance_id: string }[] = [];
let insertCalls = 0;

const fakeDb = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = strings.join("?").toLowerCase();
  if (sql.includes("select instance_id")) return Promise.resolve(selectResult);
  if (sql.includes("insert into worker_instance")) {
    insertCalls += 1;
    // Simulate the row now existing for the follow-up SELECT.
    selectResult = [{ instance_id: String(values[0]) }];
    return Promise.resolve([]);
  }
  return Promise.resolve([]);
}) as unknown as (...args: unknown[]) => unknown;

vi.mock("../../src/infra/db/index.js", () => ({ getDb: vi.fn(() => fakeDb) }));

describe("worker instance identity", () => {
  beforeEach(() => {
    vi.resetModules();
    selectResult = [];
    insertCalls = 0;
    delete process.env.VULNAGENT_INSTANCE_ID;
  });

  it("prefers VULNAGENT_INSTANCE_ID env override over any DB row", async () => {
    process.env.VULNAGENT_INSTANCE_ID = "operator-forced-id";
    selectResult = [{ instance_id: "db-id-should-be-ignored" }];
    const { initWorkerInstanceId, getWorkerInstanceId } = await import("../../src/features/workers/instance-id.js");
    const resolved = await initWorkerInstanceId();
    expect(resolved).toBe("operator-forced-id");
    expect(getWorkerInstanceId()).toBe("operator-forced-id");
  });

  it("reads the persisted DB row when present (no env override)", async () => {
    selectResult = [{ instance_id: "existing-instance-uuid" }];
    const { initWorkerInstanceId, getWorkerInstanceId } = await import("../../src/features/workers/instance-id.js");
    const resolved = await initWorkerInstanceId();
    expect(resolved).toBe("existing-instance-uuid");
    expect(getWorkerInstanceId()).toBe("existing-instance-uuid");
    expect(insertCalls).toBe(0);
  });

  it("creates and persists a new instance id on first boot (no row yet)", async () => {
    selectResult = [];
    const { initWorkerInstanceId, getWorkerInstanceId } = await import("../../src/features/workers/instance-id.js");
    const resolved = await initWorkerInstanceId();
    expect(resolved).toMatch(/^[0-9a-f-]{36}$/);
    expect(getWorkerInstanceId()).toBe(resolved);
    expect(insertCalls).toBe(1);
  });

  it("throws if getWorkerInstanceId is called before init", async () => {
    const { getWorkerInstanceId } = await import("../../src/features/workers/instance-id.js");
    expect(() => getWorkerInstanceId()).toThrow(/not initialized/);
  });
});
