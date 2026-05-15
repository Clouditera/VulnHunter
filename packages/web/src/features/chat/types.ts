/**
 * Chat domain types for Phase 6D.
 *
 * These mirror the contract confirmed with @developer:
 *   GET /api/chat/sessions/:id/messages →
 *     { messages: Array<ChatMessage> }
 *   WS /ws/chat/:sessionId →
 *     { session_id: string, ...piEvent }
 *
 * pi rpc event types are transparently forwarded by the service with a
 * single extra `session_id` field. The union `PiEvent` below matches
 * what the bridge emits to stdout.
 */

export type ChatRole = "user" | "assistant";

/**
 * Image attachment on a user prompt.
 *
 * File-path approach (per Architect's revised design, matches bossmode):
 *   1. Frontend uploads the file via `POST /api/chat/sessions/:id/upload`
 *      → server stores under `{dataDir}/chat-sessions/{sid}/attachments/`
 *      → returns `{ path: "/workspace/chat-session/attachments/<hash>.ext" }`
 *   2. Frontend prepends `Attachment: [original filename: x.png](path)`
 *      lines to the prompt text.
 *   3. pi's `read` tool natively reads the file (image / code / log).
 *
 * `preview` is a local blob URL used for thumbnail rendering inside
 * MessageBubble — session-lifetime only (revoked on unmount).
 */
export interface ChatImageAttachment {
  /** Local blob URL for <img src> (revoked on unmount). */
  preview: string;
  /** Original file name (shown in tooltip). */
  name: string;
  /** MIME type, e.g. "image/png". */
  mimeType: string;
  /** Server-side container path returned by upload. Optional because the
   *  UI may hold attachments pre-upload; set after a successful upload. */
  path?: string;
}

export interface ChatToolCall {
  /** pi tool name, e.g. "list-findings", "read-finding". */
  tool: string;
  /** JSON-stringified arguments (pretty-printed, up to a few KB). */
  args: string;
  /** JSON/text result once the tool completes. `null` while pending. */
  result?: string | null;
  /** Execution state — drives the UI spinner/color. */
  status?: "pending" | "ok" | "err";
  /** Optional error message when `status === "err"`. */
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** Assembled text content. For streaming assistants, this is the
      concatenation of all `message_update.delta` fragments received so far. */
  content: string;
  /** Monotonic sequence number assigned by the service. */
  seq: number;
  created_at: string;
  /** Tool invocations made while generating this assistant message.
      Empty / undefined for user messages. */
  tool_calls?: ChatToolCall[];
  /** True while the assistant is still streaming this message. */
  streaming?: boolean;
  /** Raw chain-of-thought captured from `thinking_*` events. Not rendered
      by default in v1.0 — reserved for a future "Show thinking" toggle. */
  thinking?: string;
  /** Image attachments. Populated only on user messages that were sent
      with paste/drop/file-picker attachments. Session-lifetime only
      (not persisted — see ChatImageAttachment JSDoc). */
  images?: ChatImageAttachment[];
}

export interface ChatSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  /** Last message preview (first 100 chars) for the sidebar. */
  preview?: string;
  /** Server-side worker state. `idle` means the worker container is
      down but can be spawned on next prompt. */
  worker_state?: "idle" | "running" | "spawning";
  /** LLM credential this session is bound to. `null` = system default.
      v1.0 is read-only; switching is Phase 12 Step 2 (needs bridge
      `models.json` + pi `set_model`). */
  credential_id?: string | null;
}

/* -------------------------------------------------------------------------- */
/*  WS event envelope                                                         */
/* -------------------------------------------------------------------------- */

export type PiEventType =
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "thinking_start"
  | "thinking_delta"
  | "thinking_end"
  | "error";

export interface PiEventBase {
  session_id: string;
  type: PiEventType;
}

export interface MessageStartEvent extends PiEventBase {
  type: "message_start";
  message_id: string;
  role: ChatRole;
}

export interface MessageUpdateEvent extends PiEventBase {
  type: "message_update";
  message_id: string;
  delta: string;
}

export interface MessageEndEvent extends PiEventBase {
  type: "message_end";
  message_id: string;
}

export interface ToolExecutionStartEvent extends PiEventBase {
  type: "tool_execution_start";
  tool_call_id: string;
  tool: string;
  args: string;
}

export interface ToolExecutionEndEvent extends PiEventBase {
  type: "tool_execution_end";
  tool_call_id: string;
  result?: string;
  error?: string;
}

export interface AgentStartEvent extends PiEventBase {
  type: "agent_start";
}
export interface AgentEndEvent extends PiEventBase {
  type: "agent_end";
}
export interface ErrorEvent extends PiEventBase {
  type: "error";
  error: string;
}

export type PiEvent =
  | AgentStartEvent
  | AgentEndEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionEndEvent
  | ErrorEvent
  | (PiEventBase & { type: PiEventType });

/* -------------------------------------------------------------------------- */
/*  Artifact references (v1.0)                                                */
/* -------------------------------------------------------------------------- */

export interface ArtifactRef {
  /** Unique key — either `bug:BUG-001` or `task:<uuid>`. Drives dedup. */
  key: string;
  kind: "finding" | "task";
  /** Display id — `BUG-001` or task short uuid. */
  display: string;
  /** Source message id that produced this ref (for jump-to-source). */
  source_message_id: string;
}

export interface ChatArtifact {
  type: "chat_artifact";
  artifact_id: string;
  title: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  preview?: string;
  download_url: string;
  created_at?: string;
}
