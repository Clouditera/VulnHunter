import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture appendMessage calls + broadcasts for system notices (task-d9b94859).
const appendCalls: Array<{ role: string; content: string }> = [];
const broadcasts: string[] = [];

vi.mock("../../src/features/chat/storage.js", () => ({
  getSession: vi.fn(async () => ({ id: "s1", tenant_id: "t1", user_id: "u1" })),
  appendMessage: vi.fn(async (p: { role: string; content: string }) => {
    appendCalls.push({ role: p.role, content: p.content });
    return {
      id: `m${appendCalls.length}`,
      session_id: "s1",
      role: p.role,
      content: p.content,
      seq: appendCalls.length,
      tool_calls: null,
      created_at: new Date("2026-08-04T00:00:00Z"),
    };
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

describe("ChatSession — bridge error events persist as system notices", () => {
  beforeEach(() => {
    appendCalls.length = 0;
    broadcasts.length = 0;
  });

  it("bridge error event -> role=system row + system_message broadcast", async () => {
    const s = new ChatSession("s1") as unknown as {
      clients: Set<{ readyState: number; send: (d: string) => void }>;
    };
    // Fake a connected client
    s.clients.add({ readyState: 1, send: (d: string) => broadcasts.push(d) });

    feed(s, { type: "error", error: "ERR_INTERNAL: Bridge exploded" });
    // persist is async (then-chain) — flush microtasks
    await new Promise((r) => setTimeout(r, 0));

    const sys = appendCalls.find((c) => c.role === "system");
    expect(sys?.content).toBe("ERR_INTERNAL: Bridge exploded");

    const sysEvent = broadcasts
      .map((b) => { try { return JSON.parse(b) as Record<string, unknown>; } catch { return null; } })
      .find((e) => e?.type === "system_message");
    expect(sysEvent).toBeTruthy();
    expect(sysEvent!.content).toBe("ERR_INTERNAL: Bridge exploded");
    expect(sysEvent!.session_id).toBe("s1");
    expect(typeof sysEvent!.seq).toBe("number");
  });

  it("error event without message falls back to ERR_INTERNAL", async () => {
    const s = new ChatSession("s1");
    feed(s, { type: "error" });
    await new Promise((r) => setTimeout(r, 0));
    expect(appendCalls.find((c) => c.role === "system")?.content).toBe("ERR_INTERNAL");
  });
});
