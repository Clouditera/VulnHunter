import type { CSSProperties } from "react";
import type { ChatMessage } from "../types.js";
import { ToolCallBlock } from "./ToolCallBlock.js";

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
          <div data-testid="chat-message-content">
            {renderInlineMarkdown(message.content)}
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

/* -------------------------------------------------------------------------- */
/*  Minimal inline markdown                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Handles:
 *   - Paragraphs separated by blank lines
 *   - `-` or `•` bullet lists
 *   - `**bold**`
 *   - `` `code` `` inline
 *   - Manual line breaks within a paragraph
 *
 * Everything else passes through as escaped text.
 */
function renderInlineMarkdown(text: string): React.ReactNode {
  const blocks = text.split(/\n{2,}/);
  return blocks.map((block, bi) => {
    const lines = block.split("\n");
    const isList = lines.every((l) => /^\s*[-•]\s/.test(l));
    if (isList) {
      return (
        <ul
          key={bi}
          style={{
            margin: "6px 0 10px 20px",
            padding: 0,
            listStyle: "disc",
          }}
        >
          {lines.map((l, li) => (
            <li
              key={li}
              style={{ marginBottom: "4px" }}
            >
              {renderInline(l.replace(/^\s*[-•]\s/, ""))}
            </li>
          ))}
        </ul>
      );
    }
    return (
      <p
        key={bi}
        style={{ margin: bi === blocks.length - 1 ? "0" : "0 0 10px" }}
      >
        {lines.map((l, li) => (
          <span key={li}>
            {renderInline(l)}
            {li < lines.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>
    );
  });
}

/**
 * Render a single line of inline markdown: `**bold**`, `` `code` ``.
 * Uses a small regex tokenizer so the output is always stable.
 */
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const tok = match[0];
    if (tok.startsWith("**")) {
      parts.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("`")) {
      parts.push(
        <code
          key={key++}
          style={{
            padding: "1px 6px",
            borderRadius: "3px",
            background: "var(--bg-page)",
            border: "1px solid var(--divider)",
            fontFamily: "'SF Mono', Menlo, Consolas, monospace",
            fontSize: "12.5px",
          }}
        >
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
