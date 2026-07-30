import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ChatArtifactApi,
  type ChatMessageApi,
  type ChatSessionApi,
} from "../../../shared/api/client.js";
import type {
  ChatActivity,
  ChatArtifact,
  ChatImageAttachment,
  ChatMessage,
  ChatSession,
  ChatToolCall,
} from "../types.js";
import {
  mapToolActivity,
  respondingActivity,
  stoppedActivity,
  thinkingActivity,
  warningActivity,
  type ActivityDraft,
} from "../activity.js";

/**
 * Real-data version of the chat hook — talks to the backend via REST +
 * WS (proxied by the service to the in-container pi bridge).
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
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({});
  const [artifactsBySession, setArtifactsBySession] = useState<Record<string, ChatArtifact[]>>({});
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastError, setLastError] = useState<string | null>(null);
  const [draftSession, setDraftSession] = useState<ChatSession | null>(null);
  const [activitiesBySession, setActivitiesBySession] = useState<Record<string, ChatActivity[]>>(
    {},
  );
  // Id of the assistant message currently being streamed (one at a time).
  const currentAssistantId = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const draftSessionRef = useRef<ChatSession | null>(null);
  activeIdRef.current = activeId;
  draftSessionRef.current = draftSession;

  const pushActivity = useCallback((sid: string, draft: ActivityDraft) => {
    const now = Date.now();
    const activity: ChatActivity = {
      id: `act-${now}-${Math.random().toString(36).slice(2, 7)}`,
      session_id: sid,
      status: draft.status,
      label: draft.label,
      detail: draft.detail,
      created_at: now,
      expires_at: draft.ttlMs ? now + draft.ttlMs : undefined,
    };
    setActivitiesBySession((prev) => ({
      ...prev,
      [sid]: [
        ...(prev[sid] ?? []).filter((a) => !a.expires_at || a.expires_at > now),
        activity,
      ].slice(-5),
    }));
  }, []);

  const expireActivities = useCallback((sid: string, ttlMs: number) => {
    const expiresAt = Date.now() + ttlMs;
    setActivitiesBySession((prev) => ({
      ...prev,
      [sid]: (prev[sid] ?? []).map((a) => (a.expires_at ? a : { ...a, expires_at: expiresAt })),
    }));
  }, []);

  const refreshArtifacts = useCallback(async (sid: string) => {
    const res = await api.chat.sessions.artifacts(sid);
    setArtifactsBySession((prev) => ({ ...prev, [sid]: res.artifacts.map(toDomainArtifact) }));
  }, []);

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
        // Do not clobber an already-selected session or a draft started via
        // "新对话" navigation from task detail (VULNHUN-170).
        setActiveId((prev) => prev ?? list[0]?.id ?? null);
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
  /*  Local title update events                                             */
  /* --------------------------------------------------------------------- */

  useEffect(() => {
    const es = new EventSource("/api/notifications", { withCredentials: true });
    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as { type?: string; sessionId?: string; title?: string };
        if (evt.type === "chat_session_title" && evt.sessionId && evt.title?.trim()) {
          setSessions((s) =>
            s.map((x) => (x.id === evt.sessionId ? { ...x, title: evt.title!.trim() } : x)),
          );
          return;
        }
        if (evt.type === "chat_artifact_created" && evt.sessionId) {
          refreshArtifacts(evt.sessionId).catch(() => {});
          pushActivity(evt.sessionId, {
            status: "success",
            label: evt.title
              ? `文件已生成：${String(evt.title).split(/[\\/]/).pop()?.slice(0, 48)}`
              : "文件已生成",
            ttlMs: 2500,
          });
        }
      } catch {
        /* ignore malformed SSE */
      }
    };
    return () => es.close();
  }, [refreshArtifacts, pushActivity]);

  /* --------------------------------------------------------------------- */
  /*  Load messages for active session                                     */
  /* --------------------------------------------------------------------- */

  useEffect(() => {
    if (!activeId || activeId === "draft") return;
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
  /*  Load durable artifacts for active session                             */
  /* --------------------------------------------------------------------- */

  useEffect(() => {
    if (!activeId || activeId === "draft") return;
    let mounted = true;
    refreshArtifacts(activeId)
      .then(() => {
        if (!mounted) return;
      })
      .catch(() => {
        if (!mounted) return;
        setArtifactsBySession((prev) => ({ ...prev, [activeId]: [] }));
      });
    return () => {
      mounted = false;
    };
  }, [activeId, refreshArtifacts]);

  useEffect(() => {
    if (!activeId) return;
    const now = Date.now();
    const activities = activitiesBySession[activeId] ?? [];
    const nextExpiry = activities
      .map((a) => a.expires_at)
      .filter((v): v is number => typeof v === "number" && v > now)
      .sort((a, b) => a - b)[0];
    if (!nextExpiry) return;
    const timer = window.setTimeout(
      () => {
        const t = Date.now();
        setActivitiesBySession((prev) => ({
          ...prev,
          [activeId]: (prev[activeId] ?? []).filter((a) => !a.expires_at || a.expires_at > t),
        }));
      },
      Math.max(0, nextExpiry - now + 25),
    );
    return () => window.clearTimeout(timer);
  }, [activeId, activitiesBySession]);

  /* --------------------------------------------------------------------- */
  /*  WebSocket lifecycle                                                   */
  /* --------------------------------------------------------------------- */

  useEffect(() => {
    if (!activeId || activeId === "draft") return;
    // Reset per-session transient state whenever we switch / reconnect.
    // Without this, a stale `currentAssistantId.current` or `streaming`
    // flag from the previous session can cause replayed bridge-proxy
    // events to append phantom bubbles to the new session.
    currentAssistantId.current = null;
    setStreaming(false);
    setLastError(null);

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
      // Idle historical sessions have no in-memory worker — server rejects WS (404).
      // History still loads via REST; only surface error while actively streaming.
      if (streaming) setLastError("WebSocket connection error");
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

  const applyEvent = useCallback(
    (sid: string, evt: PiWsEvent) => {
      switch (evt.type) {
        case "session_title":
          if (typeof evt.title === "string" && evt.title.trim()) {
            setSessions((s) =>
              s.map((x) => (x.id === sid ? { ...x, title: evt.title!.trim() } : x)),
            );
          }
          return;

        case "agent_start":
        case "turn_start":
          pushActivity(sid, thinkingActivity());
          setStreaming(true);
          setSessions((s) =>
            s.map((x) => (x.id === sid ? { ...x, worker_state: "running" as const } : x)),
          );
          return;

        case "agent_end":
        case "turn_end":
          expireActivities(sid, 2500);
          setStreaming(false);
          return;

        case "message_start": {
          const role = evt.message?.role;
          if (role !== "assistant") return; // user echoes are ignored
          // Dedup 1: if an assistant message is already in flight, keep
          // streaming into it rather than creating a second bubble.
          if (currentAssistantId.current) return;
          // Dedup 2 (belt-and-braces): if the tail of the session is already
          // a completed assistant message that was added within the last
          // second, treat this `message_start` as a replayed stale event
          // (bridge-proxy event-buffer race) and skip it. This protects
          // against the "切换 session 后消息累积" class of bugs even if
          // the backend buffer flush ever regresses.
          setMessagesBySession((prev) => {
            const arr = prev[sid] ?? [];
            const tail = arr[arr.length - 1];
            if (
              tail &&
              tail.role === "assistant" &&
              tail.streaming === false &&
              Date.now() - Date.parse(tail.created_at) < 1500
            ) {
              // Just loaded from DB or recently settled — don't double-add.
              return prev;
            }
            const id = `asst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            currentAssistantId.current = id;
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
            (b): b is { type: "thinking"; thinking: string } => b?.type === "thinking",
          );

          if (textBlock?.text) pushActivity(sid, respondingActivity());

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
            (b: { type?: string }): b is { type: "text"; text: string } => b?.type === "text",
          );

          setMessagesBySession((prev) => {
            const arr = prev[sid] ?? [];
            const idx = arr.findIndex((m) => m.id === id);
            if (idx < 0) return prev;
            const finalText = (textBlock?.text ?? arr[idx].content ?? "").trim();
            const hasToolCalls = (arr[idx].tool_calls ?? []).length > 0;

            // B16 fix: pi emits multiple message_start → message_end cycles
            // during multi-turn tool use. Some of those messages contain
            // only a `thinking` block and no `text` block, which surfaces as
            // an empty avatar bubble. When the final message has neither
            // text content nor tool calls attached, drop it entirely.
            if (!finalText && !hasToolCalls) {
              const copy = arr.slice();
              copy.splice(idx, 1);
              return { ...prev, [sid]: copy };
            }

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
          const tcId = evt.tool_call_id ?? evt.toolCallId ?? `tc-${Date.now()}`;
          const tool = evt.tool ?? evt.toolName ?? evt.name ?? "tool";
          const args = typeof evt.args === "string" ? evt.args : JSON.stringify(evt.args ?? {});
          pushActivity(sid, mapToolActivity(tool, "start"));
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
          const tcId = evt.tool_call_id ?? evt.toolCallId;
          const tool = evt.tool ?? evt.toolName ?? evt.name;
          pushActivity(sid, mapToolActivity(tool, evt.error ? "error" : "success", evt.result));
          setMessagesBySession((prev) => {
            const arr = prev[sid] ?? [];
            const idx = arr.findIndex((m) => m.id === id);
            if (idx < 0) return prev;
            const calls = (arr[idx].tool_calls ?? []).slice();
            const ci = calls.findIndex((c) => (c as unknown as { __id?: string }).__id === tcId);
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
          pushActivity(sid, warningActivity());
          setLastError(evt.error ?? "pi error");
          setStreaming(false);
          return;
        }

        default:
          return; // agent_end, turn_start, thinking_* handled above or ignored
      }
    },
    [expireActivities, pushActivity],
  );

  /* --------------------------------------------------------------------- */
  /*  Derived state                                                         */
  /* --------------------------------------------------------------------- */

  const now = Date.now();
  const activeActivities = activeId
    ? (activitiesBySession[activeId] ?? []).filter((a) => !a.expires_at || a.expires_at > now)
    : [];
  const activity = activeActivities[activeActivities.length - 1] ?? null;
  const messages = activeId ? (messagesBySession[activeId] ?? []) : [];
  const artifacts = activeId ? (artifactsBySession[activeId] ?? []) : [];
  const activeSession = useMemo(
    () =>
      draftSession && activeId === draftSession.id
        ? draftSession
        : (sessions.find((s) => s.id === activeId) ?? null),
    [sessions, activeId, draftSession],
  );

  /* --------------------------------------------------------------------- */
  /*  Actions                                                               */
  /* --------------------------------------------------------------------- */

  const selectSession = useCallback((id: string) => {
    setDraftSession(null);
    setActiveId(id);
  }, []);

  const startDraftSession = useCallback(() => {
    const draft: ChatSession = {
      id: "draft",
      title: "New Chat",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      worker_state: "idle",
      credential_id: null,
    };
    setDraftSession(draft);
    setMessagesBySession((prev) => ({ ...prev, [draft.id]: [] }));
    setActiveId(draft.id);
  }, []);

  const createSession = useCallback(async () => {
    try {
      const res = await api.chat.sessions.create();
      const s = toDomainSession(res.session);
      setDraftSession(null);
      setSessions((prev) => [s, ...prev]);
      setMessagesBySession((prev) => ({ ...prev, [s.id]: [] }));
      setActiveId(s.id);
      return s;
    } catch (err) {
      setLastError((err as Error)?.message ?? "ERR_INTERNAL");
      return null;
    }
  }, []);

  // Materialize a draft into a real (UUID) session and return its id, so callers
  // that need a persisted session before acting (e.g. uploading an attachment in
  // a brand-new conversation) don't pass the literal "draft" placeholder id.
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (draftSession && activeId === draftSession.id) {
      const created = await createSession();
      if (!created) return null;
      window.dispatchEvent(new CustomEvent("vh:sessions-changed"));
      return created.id;
    }
    return activeId;
  }, [draftSession, activeId, createSession]);

  const deleteSession = useCallback(async (id: string) => {
    // Close WS immediately so in-flight events cannot repopulate the pane.
    try {
      wsRef.current?.close();
    } catch {
      /* ignore */
    }
    wsRef.current = null;
    currentAssistantId.current = null;

    const wasActive = activeIdRef.current === id || draftSessionRef.current?.id === id;

    // Optimistic UI clear first (don't wait for network).
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setMessagesBySession((prev) => {
      const next = { ...prev };
      delete next[id];
      if (wasActive) next.draft = [];
      return next;
    });
    setArtifactsBySession((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setActivitiesBySession((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setStreaming(false);
    setLastError(null);

    if (wasActive || draftSessionRef.current?.id === id) {
      const draft: ChatSession = {
        id: "draft",
        title: "New Chat",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        worker_state: "idle",
        credential_id: null,
      };
      setDraftSession(draft);
      setActiveId(draft.id);
      activeIdRef.current = draft.id;
      draftSessionRef.current = draft;
    }

    try {
      await api.chat.sessions.delete(id);
    } catch {
      /* ignore; UI already cleared */
    }
  }, []);

  const sendPrompt = useCallback(
    async (text: string, images?: ChatImageAttachment[]) => {
      // Allow sending when there are images even with empty text
      // (mirrors ChatGPT / Claude behaviour — "describe this image").
      const hasImages = !!images && images.length > 0;
      if (!activeId || (!text.trim() && !hasImages) || streaming) return;
      let sid = activeId;
      if (draftSession && activeId === draftSession.id) {
        const created = await createSession();
        if (!created) return;
        sid = created.id;
        window.dispatchEvent(new CustomEvent("vh:sessions-changed"));
      }
      // Optimistic user message (the service does not echo user messages
      // back over WS — only assistant/tool events).
      const optimistic: ChatMessage = {
        id: `u-${Date.now()}`,
        role: "user",
        content: text,
        seq: (messagesBySession[sid]?.length ?? 0) + 1,
        created_at: new Date().toISOString(),
        images: hasImages ? images : undefined,
      };
      setMessagesBySession((prev) => ({
        ...prev,
        [sid]: [...(prev[sid] ?? []), optimistic],
      }));
      pushActivity(sid, thinkingActivity());
      setStreaming(true);
      setLastError(null);
      try {
        // Image attachments are sent as file-path references inside the
        // prompt text (ChatInput already uploaded them and appended
        // `Attachment: [name](/workspace/...)` lines). The wire prompt is
        // plain text; `images` here is local-only metadata for thumbnail
        // rendering in MessageBubble.
        await api.chat.sessions.prompt(sid, text);
        // Sidebar filters empty sessions; refresh after first message so new chat appears (VULNHUN-152).
        window.dispatchEvent(new CustomEvent("vh:sessions-changed"));
      } catch (err) {
        // Keep the user's message on screen. Append a visible error card
        // so the retry affordance is obvious.
        const e = err as Error & { code?: string };
        const code = e.code ? `${e.code}: ${e.message}` : (e.message ?? "ERR_INTERNAL");
        const userMessage = formatChatSendError(code);
        const errMsg: ChatMessage = {
          id: `e-${Date.now()}`,
          role: "assistant",
          content: userMessage,
          seq: (messagesBySession[sid]?.length ?? 0) + 2,
          created_at: new Date().toISOString(),
          streaming: false,
        };
        setMessagesBySession((prev) => ({
          ...prev,
          [sid]: [...(prev[sid] ?? []), errMsg],
        }));
        pushActivity(sid, warningActivity(userMessage));
        setStreaming(false);
        setLastError(code);
      }
    },
    [activeId, streaming, messagesBySession, pushActivity, draftSession, createSession],
  );

  const abort = useCallback(() => {
    if (!activeId) return;
    api.chat.sessions.abort(activeId).catch(() => {
      /* best-effort */
    });
    pushActivity(activeId, stoppedActivity());
    setStreaming(false);
  }, [activeId, pushActivity]);

  return {
    sessions,
    activeId,
    activeSession,
    messages,
    artifacts,
    streaming,
    activity,
    loading,
    lastError,
    selectSession,
    createSession,
    ensureSession,
    startDraftSession,
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
  toolCallId?: string;
  tool?: string;
  toolName?: string;
  name?: string;
  args?: unknown;
  result?: string;
  error?: string;
  title?: string;
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
    creator: s.creator,
    worker_state: s.worker_state ?? "idle",
    credential_id: s.credential_id ?? null,
  };
}

function toDomainArtifact(a: ChatArtifactApi): ChatArtifact {
  return {
    type: "chat_artifact",
    artifact_id: a.artifact_id,
    title: a.title,
    filename: a.filename,
    mime_type: a.mime_type,
    size_bytes: a.size_bytes,
    preview: a.preview,
    preview_status: a.preview_status,
    preview_truncated: a.preview_truncated,
    download_url: a.download_url,
    created_at: a.created_at,
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
function formatChatSendError(raw: string): string {
  if (raw.includes("ERR_NO_LLM_CREDENTIAL") || raw.includes("没有可用模型凭证") || raw.includes("请先在设置中配置模型凭证") || raw.includes("请先配置")) {
    return "请先在「设置 → 模型凭证」配置可用的模型凭证后再发送消息。";
  }
  if (raw.includes("VULNHUNTER_MASTER_KEY_FILE") || raw.includes("凭证加密 key 未配置")) {
    return "Chat 暂时无法响应：模型凭证加密 key 未配置。请管理员检查服务端 master key 配置后重试。";
  }
  if (raw.includes("无法解密") || raw.includes("cannot be decrypted")) {
    return "Chat 暂时无法响应：当前模型凭证无法解密。请在 Settings 重新保存模型凭证后重试。";
  }
  return raw;
}

function buildWsUrl(path: string): string {
  if (typeof window === "undefined") return path;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}
