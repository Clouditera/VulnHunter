import type { CSSProperties } from "react";
import type { ChatMessage } from "../types.js";
import { ToolCallBlock } from "./ToolCallBlock.js";
import { Markdown } from "./Markdown.js";

/**
 * A single message rendered inside the MessageFlow stream.
 *
 * User messages: right-aligned pill bubble (`.msg-user`).
 * Assistant messages: left-aligned with a 28px red "V" avatar and a
 *   body that supports inline markdown-ish formatting (bold, bullet
 *   lists, line breaks). Tool calls render as separate blocks before
 *   the final assistant text.
 *
 * We intentionally keep rendering lightweight — no full markdown
 * library — to avoid a bundle-size hit for v1. The formatter handles
 * the patterns pi rpc actually emits (paragraphs, `**bold**`, simple
 * `-` / `•` bullet lists, inline `code`).
 */

const USER_BUBBLE: CSSProperties = {
  marginLeft: "auto",
  maxWidth: "720px",
  background: "var(--bg-page)",
  padding: "10px 14px",
  borderRadius: "12px 12px 4px 12px",
  border: "1px solid var(--border)",
  fontSize: "14px",
  lineHeight: 1.6,
  color: "var(--text-primary)",
  width: "fit-content",
  whiteSpace: "pre-wrap",
  wordWrap: "break-word",
};

const AGENT_ROW: CSSProperties = {
  display: "flex",
  gap: "12px",
  maxWidth: "820px",
};

const AVATAR: CSSProperties = {
  width: "28px",
  height: "28px",
  borderRadius: "50%",
  background: "var(--brand)",
  color: "#fff",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "13px",
  fontWeight: 700,
  flexShrink: 0,
  marginTop: "2px",
  letterSpacing: "-0.5px",
};

const AGENT_BODY: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: "14px",
  lineHeight: 1.7,
  color: "var(--text-primary)",
};

/** Subtle card wrapper so agent text lives inside a visible bubble, matching
 *  user messages' bubble style but with a distinct fill. */
const AGENT_BUBBLE: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "4px 12px 12px 12px",
  padding: "12px 16px",
  boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
  width: "fit-content",
  maxWidth: "100%",
};

export function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div
        data-testid="chat-message"
        data-role="user"
        data-message-id={message.id}
        style={{ marginBottom: "20px" }}
      >
        <div style={USER_BUBBLE}>{message.content}</div>
      </div>
    );
  }

  return (
    <div
      data-testid="chat-message"
      data-role="assistant"
      data-message-id={message.id}
      data-streaming={message.streaming || undefined}
      style={{ marginBottom: "24px" }}
    >
      <div style={AGENT_ROW}>
        <span style={AVATAR}>V</span>
        <div style={AGENT_BODY}>
          {/* Tool calls render first, then the text. This matches pi rpc
              timing — tool calls happen before / during text generation. */}
          {(message.tool_calls ?? []).map((call, i) => (
            <ToolCallBlock key={i} call={call} />
          ))}
          <div
            data-testid="chat-message-content"
            style={message.content ? AGENT_BUBBLE : undefined}
          >
            {message.content ? <Markdown content={message.content} /> : null}
            {message.streaming ? (
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: "8px",
                  height: "15px",
                  marginLeft: "3px",
                  background: "var(--text-primary)",
                  verticalAlign: "-2px",
                  animation: "vh-caret-blink 1s steps(2) infinite",
                }}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
