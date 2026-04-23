import { useState } from "react";
import type {
  ChatImageAttachment,
  ChatMessage,
  ChatSession,
} from "../types.js";

/**
 * Temporary in-memory mock store for the chat UI while Developer builds
 * the backend (6A/6B). Once the real API + WS are ready this file is
 * replaced with `useChat.ts` that talks to the service.
 *
 * Exposed surface area mirrors what the real hook will expose so the
 * UI components don't need to change when we swap implementations:
 *   - sessions, activeSessionId, messages
 *   - createSession / selectSession / deleteSession
 *   - sendPrompt (simulates a streaming assistant reply)
 *   - abort (stops the in-flight simulation)
 */

const SEED_SESSIONS: ChatSession[] = [
  {
    id: "sess-demo-1",
    title: "clay-ui-lib security audit",
    created_at: "2026-04-21T09:22:53Z",
    updated_at: "2026-04-21T10:41:13Z",
    preview: "Walked through the 11 findings; BUG-001 and BUG-003 look like the biggest…",
    worker_state: "idle",
  },
  {
    id: "sess-demo-2",
    title: "Integer overflow review",
    created_at: "2026-04-20T14:10:00Z",
    updated_at: "2026-04-20T14:55:00Z",
    preview: "Reviewed BUG-005 integer overflow, confirmed with AddressSanitizer poc.",
    worker_state: "idle",
  },
  {
    id: "sess-demo-3",
    title: "New session",
    created_at: "2026-04-22T02:00:00Z",
    updated_at: "2026-04-22T02:00:00Z",
    preview: undefined,
    worker_state: "idle",
  },
];

const SEED_MESSAGES: Record<string, ChatMessage[]> = {
  "sess-demo-1": [
    {
      id: "m1",
      role: "user",
      content:
        "Help me triage the findings from the clay-ui-lib-v2 scan. Which ones should I prioritise?",
      seq: 1,
      created_at: "2026-04-21T10:41:30Z",
    },
    {
      id: "m2",
      role: "assistant",
      content:
        "I looked up the 11 findings for that task. The most severe are:\n\n• **BUG-001** — callback injection in clay.h:4058 (`Clay_SetMeasureTextFunction`). This is a classic function-pointer overwrite; anything calling the library with user-controlled input is at risk.\n• **BUG-003** — same class of issue in `Clay_Initialize` (clay.h:948).\n• **BUG-004** — null-pointer dereference in `Clay__MeasureTextCached` (clay.h:1643) — crashes are cheap to trigger.\n\nI'd patch BUG-001 and BUG-003 first (both are exploitable without a crash) and deprioritise the 4 `info`-severity cases. Want me to pull the detailed data-flow for any of them?",
      seq: 2,
      created_at: "2026-04-21T10:41:52Z",
      tool_calls: [
        {
          tool: "list-findings",
          args: JSON.stringify({ task_id: "b73c8887-…-115021fa781d" }, null, 2),
          result:
            '[\n  { "bug_id": "BUG-001", "severity": "medium", "vuln_type": "callback-injection" },\n  { "bug_id": "BUG-003", "severity": "medium", "vuln_type": "callback-injection" },\n  { "bug_id": "BUG-004", "severity": "medium", "vuln_type": "nullptr-deref" },\n  …\n]',
          status: "ok",
        },
      ],
    },
    {
      id: "m3",
      role: "user",
      content: "Yes — walk me through BUG-001 in detail.",
      seq: 3,
      created_at: "2026-04-21T10:42:10Z",
    },
    {
      id: "m4",
      role: "assistant",
      content:
        "`Clay_SetMeasureTextFunction` stores a caller-supplied function pointer without validating its origin. At render time (`clay.h:4058`) the pointer is invoked with a `Clay_StringSlice` the attacker also controls. If the host app exposes this surface to untrusted input, this becomes RCE.\n\nRecommended fix: keep the pointer behind an internal registry keyed by an opaque handle, and validate the handle before dispatch. I pulled the finding YAML so you can see the full data-flow if you want.",
      seq: 4,
      created_at: "2026-04-21T10:42:38Z",
      tool_calls: [
        {
          tool: "read-finding",
          args: JSON.stringify(
            { task_id: "b73c8887-…-115021fa781d", finding_key: "BUG-001" },
            null,
            2,
          ),
          result:
            "metadata:\n  vuln_type: callback-injection\n  severity: medium\n  composite_score: 3\n  confidence: high\nfile_path: /workspace/src/clay.h\nline_number: 4058\nfunction: Clay_SetMeasureTextFunction\n…",
          status: "ok",
        },
      ],
    },
  ],
  "sess-demo-2": [
    {
      id: "a1",
      role: "user",
      content: "Is BUG-005 exploitable in practice?",
      seq: 1,
      created_at: "2026-04-20T14:10:00Z",
    },
    {
      id: "a2",
      role: "assistant",
      content:
        "Yes, in the right configuration. The integer overflow in the 32-bit path lets an attacker craft a chunk that wraps the allocation size, which then writes past the buffer. AddressSanitizer catches it immediately. I can generate a minimal POC if you want to try it locally.",
      seq: 2,
      created_at: "2026-04-20T14:10:24Z",
    },
  ],
  "sess-demo-3": [],
};

export function useChatMock() {
  const [sessions, setSessions] = useState<ChatSession[]>(SEED_SESSIONS);
  const [activeId, setActiveId] = useState<string | null>(SEED_SESSIONS[0].id);
  const [messagesBySession, setMessagesBySession] =
    useState<Record<string, ChatMessage[]>>(SEED_MESSAGES);
  const [streaming, setStreaming] = useState(false);
  const abortRef = { current: false };

  const messages = activeId ? messagesBySession[activeId] ?? [] : [];

  function createSession() {
    const id = `sess-${Date.now()}`;
    const now = new Date().toISOString();
    const next: ChatSession = {
      id,
      title: "New session",
      created_at: now,
      updated_at: now,
      worker_state: "idle",
    };
    setSessions((prev) => [next, ...prev]);
    setMessagesBySession((prev) => ({ ...prev, [id]: [] }));
    setActiveId(id);
  }

  function deleteSession(id: string) {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setMessagesBySession((prev) => {
      const { [id]: _gone, ...rest } = prev;
      void _gone;
      return rest;
    });
    setActiveId((prev) => (prev === id ? sessions[0]?.id ?? null : prev));
  }

  async function sendPrompt(text: string, images?: ChatImageAttachment[]) {
    const hasImages = !!images && images.length > 0;
    if (!activeId || (!text.trim() && !hasImages) || streaming) return;
    const sid = activeId;
    const now = new Date().toISOString();
    const prior = messagesBySession[sid] ?? [];
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
      seq: prior.length + 1,
      created_at: now,
      images: hasImages ? images : undefined,
    };
    const assistantMsg: ChatMessage = {
      id: `a-${Date.now()}`,
      role: "assistant",
      content: "",
      seq: prior.length + 2,
      created_at: now,
      streaming: true,
    };
    setMessagesBySession((prev) => ({
      ...prev,
      [sid]: [...prior, userMsg, assistantMsg],
    }));
    setStreaming(true);
    abortRef.current = false;

    // Simulate streaming chunks
    const mockReply = buildMockReply(text);
    const chunks = chunkString(mockReply, 6);
    for (const chunk of chunks) {
      if (abortRef.current) break;
      await sleep(30);
      setMessagesBySession((prev) => {
        const arr = prev[sid] ?? [];
        const last = arr[arr.length - 1];
        if (!last || last.id !== assistantMsg.id) return prev;
        const updated: ChatMessage = { ...last, content: last.content + chunk };
        return { ...prev, [sid]: [...arr.slice(0, -1), updated] };
      });
    }
    // Finalise
    setMessagesBySession((prev) => {
      const arr = prev[sid] ?? [];
      const last = arr[arr.length - 1];
      if (!last || last.id !== assistantMsg.id) return prev;
      const updated: ChatMessage = { ...last, streaming: false };
      return { ...prev, [sid]: [...arr.slice(0, -1), updated] };
    });
    setStreaming(false);
  }

  function abort() {
    abortRef.current = true;
  }

  return {
    sessions,
    activeId,
    activeSession: sessions.find((s) => s.id === activeId) ?? null,
    messages,
    streaming,
    selectSession: setActiveId,
    createSession,
    deleteSession,
    sendPrompt,
    abort,
  };
}

/* -------------------------------------------------------------------------- */
/*  helpers                                                                   */
/* -------------------------------------------------------------------------- */

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function chunkString(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

function buildMockReply(prompt: string): string {
  if (/BUG-\d+/i.test(prompt)) {
    const m = prompt.match(/BUG-\d+/i)!;
    return `Pulling details for **${m[0]}**…\n\nThat one lives in \`clay.h\` and flows through \`Clay_SetMeasureTextFunction\`. If you want the full data-flow I can read the finding YAML — shall I?`;
  }
  if (/scan/i.test(prompt)) {
    return `Sure, I can start a scan. Which repository or archive should I point it at?`;
  }
  return `Got it. This is a demo reply — the real worker (pi rpc) is still being wired up by Developer. Once that's done I'll answer for real. In the meantime you can try asking me about "BUG-001" to see how tool calls render.`;
}
