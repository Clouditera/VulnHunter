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
  // Extract fenced code blocks first so their ``` markers don't confuse
  // the paragraph/table splitter.
  const codeBlocks: Array<{ lang: string; code: string }> = [];
  const withPlaceholders = text.replace(
    /```([^\n]*)\n([\s\S]*?)```/g,
    (_m, lang, code) => {
      const i = codeBlocks.length;
      codeBlocks.push({ lang: (lang || "").trim(), code });
      return `\x00CODE${i}\x00`;
    },
  );

  const blocks = withPlaceholders.split(/\n{2,}/);
  return blocks.map((block, bi) => {
    // Re-inflate code block placeholders.
    const codeMatch = block.match(/^\x00CODE(\d+)\x00$/);
    if (codeMatch) {
      const cb = codeBlocks[Number(codeMatch[1])];
      return (
        <pre
          key={bi}
          style={{
            margin: bi === blocks.length - 1 ? "4px 0 0" : "4px 0 10px",
            padding: "12px 14px",
            background: "var(--bg-page)",
            border: "1px solid var(--divider)",
            borderRadius: "6px",
            overflow: "auto",
            fontSize: "12.5px",
            fontFamily: "'SF Mono', Menlo, Consolas, monospace",
            lineHeight: 1.5,
          }}
        >
          <code>{cb.code.replace(/\n$/, "")}</code>
        </pre>
      );
    }

    const lines = block.split("\n");

    // ATX headers (###, ##, #) — standalone line blocks.
    const headerMatch = /^(#{1,4})\s+(.+)$/.exec(block);
    if (headerMatch && lines.length === 1) {
      const level = headerMatch[1].length;
      const fontSize = { 1: "18px", 2: "16px", 3: "15px", 4: "14px" }[
        level as 1 | 2 | 3 | 4
      ];
      return (
        <div
          key={bi}
          style={{
            fontSize,
            fontWeight: 700,
            margin: bi === 0 ? "0 0 8px" : "12px 0 6px",
            color: "var(--text-primary)",
          }}
        >
          {renderInline(headerMatch[2])}
        </div>
      );
    }

    // Markdown table: first row has pipes, second row is --- separators.
    if (
      lines.length >= 2 &&
      /\|/.test(lines[0]) &&
      /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[1])
    ) {
      const splitRow = (row: string) =>
        row
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim());
      const headers = splitRow(lines[0]);
      const rows = lines.slice(2).map(splitRow);
      return (
        <div
          key={bi}
          style={{
            margin: bi === blocks.length - 1 ? "4px 0 0" : "4px 0 12px",
            overflow: "auto",
          }}
        >
          <table
            style={{
              borderCollapse: "collapse",
              fontSize: "13px",
              width: "auto",
              minWidth: "40%",
            }}
          >
            <thead>
              <tr>
                {headers.map((h, i) => (
                  <th
                    key={i}
                    style={{
                      padding: "6px 12px",
                      textAlign: "left",
                      fontWeight: 600,
                      borderBottom: "2px solid var(--divider)",
                      color: "var(--text-primary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td
                      key={ci}
                      style={{
                        padding: "6px 12px",
                        borderBottom: "1px solid var(--divider)",
                        verticalAlign: "top",
                      }}
                    >
                      {renderInline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

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

    const isOrdered = lines.every((l) => /^\s*\d+\.\s/.test(l));
    if (isOrdered) {
      return (
        <ol
          key={bi}
          style={{ margin: "6px 0 10px 22px", padding: 0 }}
        >
          {lines.map((l, li) => (
            <li key={li} style={{ marginBottom: "4px" }}>
              {renderInline(l.replace(/^\s*\d+\.\s/, ""))}
            </li>
          ))}
        </ol>
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
  // Order: links [text](url), bold **x**, inline code `x`
  const re = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const tok = match[0];
    if (tok.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (linkMatch) {
        parts.push(
          <a
            key={key++}
            href={linkMatch[2]}
            target="_blank"
            rel="noreferrer"
            style={{
              color: "var(--brand)",
              textDecoration: "underline",
            }}
          >
            {linkMatch[1]}
          </a>,
        );
      } else {
        parts.push(tok);
      }
    } else if (tok.startsWith("**")) {
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
