import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the values interpolated into tagged-template SQL calls so we can
// assert that appendMessage now persists tool_calls (the persistence fix).
let calls: { strings: string[]; values: unknown[] }[] = [];

const fakeDb = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  calls.push({ strings: [...strings], values });
  const sql = strings.join("?").toLowerCase();
  if (sql.includes("from chat_sessions")) {
    return Promise.resolve([{ id: "s1", tenant_id: "t1", user_id: "u1" }]);
  }
  if (sql.includes("max(seq)")) return Promise.resolve([{ max: 2 }]);
  if (sql.includes("insert into chat_messages")) {
    return Promise.resolve([{ id: "m1", seq: 3, tool_calls: values[values.length - 1] }]);
  }
  return Promise.resolve([]);
}) as unknown as { json: (v: unknown) => unknown };
fakeDb.json = (v: unknown) => ({ __json: v });

vi.mock("../../src/infra/db/client.js", () => ({ getDb: vi.fn(() => fakeDb) }));

const { appendMessage } = await import("../../src/features/chat/storage.js");

describe("appendMessage — tool_calls persistence", () => {
  beforeEach(() => { calls = []; });

  it("persists tool_calls JSONB when present (cards survive refresh)", async () => {
    const tc = [{ tool: "present-artifact", args: "", result: '{"type":"chat_artifact"}' }];
    const row = await appendMessage({ sessionId: "s1", role: "assistant", content: "done", toolCalls: tc });
    const insert = calls.find((c) => c.strings.join("").toLowerCase().includes("insert into chat_messages"));
    expect(insert).toBeTruthy();
    // last interpolated value is the JSON-wrapped tool_calls array
    const last = insert!.values[insert!.values.length - 1] as { __json: unknown };
    expect(last.__json).toEqual(tc);
    expect(insert!.strings.join("")).toContain("tool_calls");
    expect(row.tool_calls).toEqual({ __json: tc });
  });

  it("stores null when there are no tool calls", async () => {
    await appendMessage({ sessionId: "s1", role: "user", content: "hi" });
    const insert = calls.find((c) => c.strings.join("").toLowerCase().includes("insert into chat_messages"));
    expect(insert!.values[insert!.values.length - 1]).toBeNull();
  });

  it("stores null for an empty tool_calls array", async () => {
    await appendMessage({ sessionId: "s1", role: "assistant", content: "x", toolCalls: [] });
    const insert = calls.find((c) => c.strings.join("").toLowerCase().includes("insert into chat_messages"));
    expect(insert!.values[insert!.values.length - 1]).toBeNull();
  });
});
