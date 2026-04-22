import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ChatMessageApi, type ChatSessionApi } from "../../../shared/api/client.js";
import type { ChatMessage, ChatSession, ChatToolCall, PiEvent } from "../types.js";

/**
 * Real-data version of the chat hook — talks to the backend via REST +
 * WS (proxied by the service to the in-container bridge).
 *
 * Contract (6B, as discussed with @developer):
 *   REST  GET    /api/chat/sessions                 → { sessions }
 *         POST   /api/chat/sessions                 → { session }
 *         DELETE /api/chat/sessions/:id             → { ok }
 *         GET    /api/chat/sessions/:id/messages    → { messages }
 *         POST   /api/chat/sessions/:id/prompt      → { ok }
 *         POST   /api/chat/sessions/:id/abort       → { ok }
 *   WS    /ws/chat/:sessionId                        → envelope events:
 *           { session_id, type: 'message_start' | ..., ... }
 *
 * Events we act on:
 *   message_start         → append empty assistant message, start streaming
 *   message_update        → append delta to current assistant message
 *   message_end           → mark streaming=false; refetch to reconcile
 *   tool_execution_start  → push pending tool_call onto current message
 *   tool_execution_end    → resolve the matching tool_call (ok/err)
 *   thinking_*            → collected into a per-message `thinking` buffer
 *                           for the v1.0 "Show thinking" toggle (not rendered
 *                           by default — dropped from UI unless user asks)
 *   agent_start/end       → worker_state toggled on the local session
 *   error                 → surfaced via the lastError state field
 *
 * This hook exposes the same surface area as `useChatMock` so ChatPage
 * can swap one import for the other.
 */

export function useChat() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messagesBySession, setMessagesBySession] =
    useState<Record<string, ChatMessage[]>>({});
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastError, setLastError] = useState<string | null>(null);
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
    // Short-circuit if we already have a populated buffer (avoid clobbering
    // streaming in-flight messages when the user toggles sessions).
    if ((messagesBySession[activeId] ?? []).length > 0) return;
    api.chat.sessions
      .messages(activeId)
      .then((res) => {
        if (!mounted) return;
        const msgs = res.messages.map(toDomainMessage);
        setMessagesBySession((prev) => ({ ...prev, [activeId]: msgs }));
      })
      .catch(() => {
        /* 404 just means fresh session — leave [] */
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
      let parsed: PiEvent;
      try {
        parsed = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return;
      applyEvent(activeId, parsed);
    };

    ws.onerror = () => {
      setLastError("WebSocket connection error");
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  /* --------------------------------------------------------------------- */
  /*  Reducer — mutate messagesBySession based on pi event                  */
  /* --------------------------------------------------------------------- */

  const applyEvent = useCallback((sid: string, evt: PiEvent) => {
    setMessagesBySession((prev) => {
      const arr = prev[sid] ?? [];

      switch (evt.type) {
        case "message_start": {
          // Push an empty assistant message we'll stream into.
          const e = evt as typeof evt & { message_id: string; role: "user" | "assistant" };
          if (e.role !== "assistant") return prev; // ignore user echoes
          const next: ChatMessage = {
            id: e.message_id,
            role: "assistant",
            content: "",
            seq: arr.length + 1,
            created_at: new Date().toISOString(),
            streaming: true,
            tool_calls: [],
          };
          return { ...prev, [sid]: [...arr, next] };
        }

        case "message_update": {
          const e = evt as typeof evt & { message_id: string; delta: string };
          const idx = arr.findIndex((m) => m.id === e.message_id);
          if (idx < 0) return prev;
          const updated: ChatMessage = {
            ...arr[idx],
            content: arr[idx].content + (e.delta ?? ""),
          };
          const copy = arr.slice();
          copy[idx] = updated;
          return { ...prev, [sid]: copy };
        }

        case "message_end": {
          const e = evt as typeof evt & { message_id: string };
          const idx = arr.findIndex((m) => m.id === e.message_id);
          if (idx < 0) return prev;
          const updated: ChatMessage = { ...arr[idx], streaming: false };
          const copy = arr.slice();
          copy[idx] = updated;
          return { ...prev, [sid]: copy };
        }

        case "tool_execution_start": {
          const e = evt as typeof evt & {
            tool_call_id: string;
            tool: string;
            args: string;
          };
          // Attach to the most recent assistant message (in progress).
          const idx = lastAssistantIndex(arr);
          if (idx < 0) return prev;
          const newCall: ChatToolCall = {
            tool: e.tool,
            args: e.args ?? "",
            status: "pending",
          };
          const existing = arr[idx].tool_calls ?? [];
          const updated: ChatMessage = {
            ...arr[idx],
            tool_calls: [
              ...existing,
              Object.assign(newCall, { __id: e.tool_call_id }),
            ],
          };
          const copy = arr.slice();
          copy[idx] = updated;
          return { ...prev, [sid]: copy };
        }

        case "tool_execution_end": {
          const e = evt as typeof evt & {
            tool_call_id: string;
            result?: string;
            error?: string;
          };
          const idx = lastAssistantIndex(arr);
          if (idx < 0) return prev;
          const calls = (arr[idx].tool_calls ?? []).slice();
          const callIdx = calls.findIndex(
            (c) => (c as unknown as { __id?: string }).__id === e.tool_call_id,
          );
          if (callIdx < 0) return prev;
          calls[callIdx] = {
            ...calls[callIdx],
            status: e.error ? "err" : "ok",
            result: e.result ?? null,
            error: e.error,
          };
          const updated: ChatMessage = { ...arr[idx], tool_calls: calls };
          const copy = arr.slice();
          copy[idx] = updated;
          return { ...prev, [sid]: copy };
        }

        case "agent_start":
          setStreaming(true);
          setSessions((s) =>
            s.map((x) =>
              x.id === sid ? { ...x, worker_state: "running" as const } : x,
            ),
          );
          return prev;

        case "agent_end":
          setStreaming(false);
          // Worker often stays running for 10 min of idleness — don't flip
          // back to "idle" until the server tells us explicitly.
          return prev;

        case "error": {
          const e = evt as typeof evt & { error?: string };
          setLastError(e.error ?? "pi error");
          setStreaming(false);
          return prev;
        }

        default:
          return prev;
      }
    });
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
        /* ignore; the UI removal below is what matters to the user */
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
      // Optimistic user message (the service won't echo ours back via WS).
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
        // Keep the user message visible (users get anxious when their
        // text disappears) and surface an error "reply" so they know the
        // send didn't go through. They can retry.
        const code = (err as Error)?.message ?? "ERR_INTERNAL";
        const errorMsg: ChatMessage = {
          id: `e-${Date.now()}`,
          role: "assistant",
          content: `⚠️ ${code}`,
          seq: (messagesBySession[sid]?.length ?? 0) + 2,
          created_at: new Date().toISOString(),
          streaming: false,
        };
        setMessagesBySession((prev) => ({
          ...prev,
          [sid]: [...(prev[sid] ?? []), errorMsg],
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

function lastAssistantIndex(arr: ChatMessage[]): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].role === "assistant") return i;
  }
  return -1;
}

/** Build a ws:// or wss:// URL from a path, honouring current scheme/host. */
function buildWsUrl(path: string): string {
  if (typeof window === "undefined") return path;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}
