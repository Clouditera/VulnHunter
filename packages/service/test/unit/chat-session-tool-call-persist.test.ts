import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture appendMessage calls to assert which assistant messages get persisted
// (and with what tool_calls) across a multi-message pi tool turn.
const appendCalls: Array<{ content: string; toolCalls?: unknown[] }> = [];

vi.mock("../../src/features/chat/storage.js", () => ({
  getSession: vi.fn(async () => ({ id: "s1", tenant_id: "t1", user_id: "u1" })),
  appendMessage: vi.fn(async (p: { content: string; toolCalls?: unknown[] }) => {
    appendCalls.push({ content: p.content, toolCalls: p.toolCalls });
    return { id: `m${appendCalls.length}` };
  }),
}));
vi.mock("../../src/features/auth/storage.js", () => ({ getUserById: vi.fn() }));
vi.mock("../../src/features/chat/title-generation.js", () => ({
  maybeGenerateTitle: vi.fn(async () => null),
}));

const { ChatSession } = await import("../../src/features/chat/chat-session.js");

function feed(session: unknown, event: Record<string, unknown>): void {
  (session as { handleBridgeEvent: (l: string) => void }).handleBridgeEvent(JSON.stringify(event));
}

describe("ChatSession — tool-call persistence across multi-message tool turn", () => {
  beforeEach(() => {
    appendCalls.length = 0;
  });

  it("persists a tool-bearing assistant message that has NO text block", async () => {
    const s = new ChatSession("s1");
    // Message #1: assistant calls emit-reference, no text block.
    feed(s, { type: "message_start", message: { role: "assistant" } });
    feed(s, {
      type: "tool_execution_end",
      tool: "emit-reference",
      result: '{"type":"task_ref","task_id":"abc","title":"Demo"}',
    });
    feed(s, { type: "message_end", message: { role: "assistant", content: [] } });
    // Message #2: final assistant text answer, no tools.
    feed(s, { type: "message_start", message: { role: "assistant" } });
    feed(s, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "已为你展示卡片" }] } });
    feed(s, { type: "agent_end" });

    // The tool-bearing message (no text) MUST be persisted with its tool_calls.
    const withTools = appendCalls.find((c) => (c.toolCalls?.length ?? 0) > 0);
    expect(withTools).toBeTruthy();
    expect(withTools!.toolCalls).toEqual([
      { tool: "emit-reference", args: "", result: '{"type":"task_ref","task_id":"abc","title":"Demo"}' },
    ]);
    // The final text message persists too, with no stale tool_calls.
    const textMsg = appendCalls.find((c) => c.content === "已为你展示卡片");
    expect(textMsg).toBeTruthy();
    expect(textMsg!.toolCalls).toBeUndefined();
  });

  it("does not lose tool calls to a subsequent message_start reset", async () => {
    const s = new ChatSession("s1");
    feed(s, { type: "message_start", message: { role: "assistant" } });
    feed(s, { type: "tool_execution_end", tool: "present-artifact", result: '{"type":"chat_artifact"}' });
    // A new message_start arrives BEFORE the tool-bearing message_end is flushed
    // in some orderings — the safety flush at agent_end must still persist it.
    feed(s, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
    feed(s, { type: "agent_end" });

    const withTools = appendCalls.find((c) => (c.toolCalls?.length ?? 0) > 0);
    expect(withTools).toBeTruthy();
  });
});
