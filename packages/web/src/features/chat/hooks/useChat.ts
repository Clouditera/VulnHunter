import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ChatMessageApi, type ChatSessionApi } from "../../../shared/api/client.js";
import type { ChatMessage, ChatSession, ChatToolCall } from "../types.js";

/**
 * Real-data version of the chat hook — talks to the backend via REST +
 * WS (proxied by the service to the in-container pi bridge).
 *
 * Same surface area as `useChatMock` so ChatPage can swap one import for
 * the other. The mock stays in the tree for demos / offline dev.
 *
 * ## Actual event shape (verified against live backend)
 *
 * The shape the bridge emits differs from the flat `{message_id, delta}`
 * contract we initially sketched. Every event is wrapped with
 * `{session_id, type, ...}` by the service proxy, and for streaming the
 * payload is nested:
 *
 *   message_start  { message: { role, content: [] } }
 *   message_update { assistantMessageEvent: {
 *                      type: "text_delta" | "text_start" | "text_end"
 *                          | "thinking_*",
 *                      contentIndex: number,
 *                      delta: string,
 *                      partial: { role, content: [{type:'thinking'|'text', ...}] }
 *                    } }
 *   message_end    { message: { role, content: [...blocks...] } }
 *   turn_end       { message: { ... } }
 *   agent_end      { messages: [...] }
 *
 * Key insight: `assistantMessageEvent.partial.content` carries the full
 * snapshot up to the current chunk. We use that as the source of truth
 * instead of accumulating deltas — it makes the reducer idempotent
 * (events occasionally arrive twice; replacing with the snapshot is a
 * no-op on duplicates).
 *
 * ## Thinking
 *
 * Per earlier discussion, `thinking_*` events are not rendered in v1.0.
 * We still capture the thinking text in `message.thinking` (future-proof
 * for a "Show thinking" toggle), but `MessageBubble` doesn't surface it.
 *
 * ## Tool calls
 *
 * Not yet emitted on the path we verified (no MCP server wired); the
 * reducer handles `tool_execution_*` defensively so the UI works once
 * Developer lands 6C.
 */

export function useChat() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messagesBySession, setMessagesBySession] =
    useState<Record<string, ChatMessage[]>>({});
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastError, setLastError] = useState<string | null>(null);
  // Id of the assistant message currently being streamed (one at a time).
  const currentAssistantId = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  /* --------------------------------------------------------------------- */
  /*  Initial session list                                                 */
  /* --------------------------------------------------------------------- */

  useEffect(() => {
    let mounted = true;
    api.chat.sessions
      .list()
      .then((res) => {
        if (!mounted) return;
        const list = res.sessions.map(toDomainSession);
        setSessions(list);
        setActiveId(list[0]?.id ?? null);
        setLoading(false);
      })
      .catch((err) => {
        if (!mounted) return;
        setLastError((err as Error)?.message ?? "ERR_INTERNAL");
        setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  /* --------------------------------------------------------------------- */
  /*  Load messages for active session                                     */
  /* --------------------------------------------------------------------- */

  useEffect(() => {
    if (!activeId) return;
    let mounted = true;
    // Short-circuit if we already have a populated buffer (switching away +
    // back shouldn't clobber in-flight streams).
    if ((messagesBySession[activeId] ?? []).length > 0) return;
    api.chat.sessions
      .messages(activeId)
      .then((res) => {
        if (!mounted) return;
        const msgs = res.messages.map(toDomainMessage);
        setMessagesBySession((prev) => ({ ...prev, [activeId]: msgs }));
      })
      .catch(() => {
        /* fresh session — leave [] */
      });
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  /* --------------------------------------------------------------------- */
  /*  WebSocket lifecycle                                                   */
  /* --------------------------------------------------------------------- */

  useEffect(() => {
    if (!activeId) return;
    const wsUrl = buildWsUrl(`/ws/chat/${activeId}`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return;
      applyEvent(activeId, parsed as PiWsEvent);
    };

    ws.onerror = () => {
      setLastError("WebSocket connection error");
    };

    return () => {
      ws.close();
      wsRef.current = null;
      currentAssistantId.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  /* --------------------------------------------------------------------- */
  /*  Event reducer                                                         */
  /* --------------------------------------------------------------------- */

  const applyEvent = useCallback((sid: string, evt: PiWsEvent) => {
    switch (evt.type) {
      case "agent_start":
        setStreaming(true);
        setSessions((s) =>
          s.map((x) =>
            x.id === sid ? { ...x, worker_state: "running" as const } : x,
          ),
        );
        return;

      case "agent_end":
      case "turn_end":
        setStreaming(false);
        return;

      case "message_start": {
        const role = evt.message?.role;
        if (role !== "assistant") return; // user echoes are ignored
        // Dedup: the service currently forwards duplicate events (known
        // backend issue). If an assistant message is already in flight,
        // keep streaming into it rather than creating a second bubble.
        if (currentAssistantId.current) return;
        const id = `asst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        currentAssistantId.current = id;
        setMessagesBySession((prev) => {
          const arr = prev[sid] ?? [];
          const newMsg: ChatMessage = {
            id,
            role: "assistant",
            content: "",
            seq: arr.length + 1,
            created_at: new Date().toISOString(),
            streaming: true,
            tool_calls: [],
          };
          return { ...prev, [sid]: [...arr, newMsg] };
        });
        return;
      }

      case "message_update": {
        const inner = evt.assistantMessageEvent;
        if (!inner) return;
        const id = currentAssistantId.current;
        if (!id) return;

        // Extract text content from the full partial snapshot — idempotent
        // under duplicate events. `partial.content` is an array of
        // `{type: 'thinking'|'text', ...}` blocks.
        const blocks = inner.partial?.content ?? [];
        const textBlock = blocks.find(
          (b): b is { type: "text"; text: string } => b?.type === "text",
        );
        const thinkingBlock = blocks.find(
          (b): b is { type: "thinking"; thinking: string } =>
            b?.type === "thinking",
        );

        setMessagesBySession((prev) => {
          const arr = prev[sid] ?? [];
          const idx = arr.findIndex((m) => m.id === id);
          if (idx < 0) return prev;
          const next: ChatMessage = {
            ...arr[idx],
            content: textBlock?.text ?? arr[idx].content,
            // Stash thinking for the future "Show thinking" toggle.
            // v1.0 UI never reads this field.
            thinking: thinkingBlock?.thinking ?? arr[idx].thinking,
          };
          const copy = arr.slice();
          copy[idx] = next;
          return { ...prev, [sid]: copy };
        });
        return;
      }

      case "message_end": {
        const role = evt.message?.role;
        if (role !== "assistant") return;
        const id = currentAssistantId.current;
        if (!id) return;

        // Reconcile against the final snapshot just in case we missed a
        // delta. Same "partial = truth" approach.
        const blocks = evt.message?.content ?? [];
        const textBlock = blocks.find(
          (b: { type?: string }): b is { type: "text"; text: string } =>
            b?.type === "text",
        );

        setMessagesBySession((prev) => {
          const arr = prev[sid] ?? [];
          const idx = arr.findIndex((m) => m.id === id);
          if (idx < 0) return prev;
          const next: ChatMessage = {
            ...arr[idx],
            content: textBlock?.text ?? arr[idx].content,
            streaming: false,
          };
          const copy = arr.slice();
          copy[idx] = next;
          return { ...prev, [sid]: copy };
        });
        currentAssistantId.current = null;
        return;
      }

      case "tool_execution_start": {
        const id = currentAssistantId.current;
        if (!id) return;
        const tcId = evt.tool_call_id ?? `tc-${Date.now()}`;
        const tool = evt.tool ?? evt.name ?? "tool";
        const args =
          typeof evt.args === "string" ? evt.args : JSON.stringify(evt.args ?? {});
        setMessagesBySession((prev) => {
          const arr = prev[sid] ?? [];
          const idx = arr.findIndex((m) => m.id === id);
          if (idx < 0) return prev;
          const existing = arr[idx].tool_calls ?? [];
          const call: ChatToolCall & { __id: string } = {
            __id: tcId,
            tool,
            args,
            status: "pending",
          };
          const copy = arr.slice();
          copy[idx] = { ...arr[idx], tool_calls: [...existing, call] };
          return { ...prev, [sid]: copy };
        });
        return;
      }

      case "tool_execution_end": {
        const id = currentAssistantId.current;
        if (!id) return;
        const tcId = evt.tool_call_id;
        setMessagesBySession((prev) => {
          const arr = prev[sid] ?? [];
          const idx = arr.findIndex((m) => m.id === id);
          if (idx < 0) return prev;
          const calls = (arr[idx].tool_calls ?? []).slice();
          const ci = calls.findIndex(
            (c) => (c as unknown as { __id?: string }).__id === tcId,
          );
          if (ci < 0) return prev;
          calls[ci] = {
            ...calls[ci],
            status: evt.error ? "err" : "ok",
            result: evt.result ?? null,
            error: evt.error,
          };
          const copy = arr.slice();
          copy[idx] = { ...arr[idx], tool_calls: calls };
          return { ...prev, [sid]: copy };
        });
        return;
      }

      case "error": {
        setLastError(evt.error ?? "pi error");
        setStreaming(false);
        return;
      }

      default:
        return; // agent_end, turn_start, thinking_* handled above or ignored
    }
  }, []);

  /* --------------------------------------------------------------------- */
  /*  Derived state                                                         */
  /* --------------------------------------------------------------------- */

  const messages = activeId ? messagesBySession[activeId] ?? [] : [];
  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );

  /* --------------------------------------------------------------------- */
  /*  Actions                                                               */
  /* --------------------------------------------------------------------- */

  const selectSession = useCallback((id: string) => setActiveId(id), []);

  const createSession = useCallback(async () => {
    try {
      const res = await api.chat.sessions.create();
      const s = toDomainSession(res.session);
      setSessions((prev) => [s, ...prev]);
      setMessagesBySession((prev) => ({ ...prev, [s.id]: [] }));
      setActiveId(s.id);
    } catch (err) {
      setLastError((err as Error)?.message ?? "ERR_INTERNAL");
    }
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await api.chat.sessions.delete(id);
      } catch {
        /* ignore; UI removal is what the user sees */
      }
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setMessagesBySession((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setActiveId((prev) => {
        if (prev !== id) return prev;
        const rest = sessions.filter((s) => s.id !== id);
        return rest[0]?.id ?? null;
      });
    },
    [sessions],
  );

  const sendPrompt = useCallback(
    async (text: string) => {
      if (!activeId || !text.trim() || streaming) return;
      const sid = activeId;
      // Optimistic user message (the service does not echo user messages
      // back over WS — only assistant/tool events).
      const optimistic: ChatMessage = {
        id: `u-${Date.now()}`,
        role: "user",
        content: text,
        seq: (messagesBySession[sid]?.length ?? 0) + 1,
        created_at: new Date().toISOString(),
      };
      setMessagesBySession((prev) => ({
        ...prev,
        [sid]: [...(prev[sid] ?? []), optimistic],
      }));
      setStreaming(true);
      setLastError(null);
      try {
        await api.chat.sessions.prompt(sid, text);
      } catch (err) {
        // Keep the user's message on screen. Append a visible error card
        // so the retry affordance is obvious.
        const code = (err as Error)?.message ?? "ERR_INTERNAL";
        const errMsg: ChatMessage = {
          id: `e-${Date.now()}`,
          role: "assistant",
          content: `⚠️ ${code}`,
          seq: (messagesBySession[sid]?.length ?? 0) + 2,
          created_at: new Date().toISOString(),
          streaming: false,
        };
        setMessagesBySession((prev) => ({
          ...prev,
          [sid]: [...(prev[sid] ?? []), errMsg],
        }));
        setStreaming(false);
        setLastError(code);
      }
    },
    [activeId, streaming, messagesBySession],
  );

  const abort = useCallback(() => {
    if (!activeId) return;
    api.chat.sessions.abort(activeId).catch(() => {
      /* best-effort */
    });
    setStreaming(false);
  }, [activeId]);

  return {
    sessions,
    activeId,
    activeSession,
    messages,
    streaming,
    loading,
    lastError,
    selectSession,
    createSession,
    deleteSession,
    sendPrompt,
    abort,
  };
}

/* -------------------------------------------------------------------------- */
/*  Loose event type (only the fields we read)                                */
/* -------------------------------------------------------------------------- */

interface PiWsEvent {
  type: string;
  session_id?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string; thinking?: string }>;
  };
  assistantMessageEvent?: {
    type?: string;
    contentIndex?: number;
    delta?: string;
    partial?: {
      role?: string;
      content?: Array<{ type?: string; text?: string; thinking?: string }>;
    };
  };
  tool_call_id?: string;
  tool?: string;
  name?: string;
  args?: unknown;
  result?: string;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/*  helpers                                                                   */
/* -------------------------------------------------------------------------- */

function toDomainSession(s: ChatSessionApi): ChatSession {
  return {
    id: s.id,
    title: s.title || "Untitled",
    created_at: s.created_at,
    updated_at: s.updated_at,
    preview: s.preview ?? undefined,
    worker_state: s.worker_state ?? "idle",
  };
}

function toDomainMessage(m: ChatMessageApi): ChatMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    seq: m.seq,
    created_at: m.created_at,
    tool_calls: m.tool_calls?.map((c) => ({
      tool: c.tool,
      args: c.args,
      result: c.result ?? null,
      error: c.error ?? undefined,
      status: c.error ? ("err" as const) : c.result ? ("ok" as const) : ("pending" as const),
    })),
  };
}

/** Build a ws:// or wss:// URL from a path. */
function buildWsUrl(path: string): string {
  if (typeof window === "undefined") return path;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}
