import { useState } from "react";
import type { CSSProperties } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import type { ChatToolCall } from "../types.js";

/**
 * Collapsible block that renders a single MCP tool invocation inside an
 * assistant message.
 *
 * Visual:
 *   [icon] {tool name}   [status pill]   [chevron]
 *      ├── ARGUMENTS   (mono, dark)
 *      └── RESULT      (mono, dark; or ERROR in red)
 *
 * The block is always visible (it's an inline status affordance), but
 * the args/result panels collapse to save space. Default collapsed when
 * the call has completed successfully — users rarely need to inspect it.
 */

const STATUS_STYLE: Record<
  NonNullable<ChatToolCall["status"]>,
  { bg: string; fg: string; label: string }
> = {
  pending: {
    bg: "rgba(202,138,4,0.12)",
    fg: "var(--sev-medium)",
    label: "chat.tool.pending",
  },
  ok: {
    bg: "var(--bg-success)",
    fg: "var(--bg-success-text)",
    label: "chat.tool.ok",
  },
  err: {
    bg: "var(--bg-error)",
    fg: "var(--brand)",
    label: "chat.tool.err",
  },
};

const BLOCK: CSSProperties = {
  background: "var(--bg-page)",
  border: "1px solid var(--border)",
  borderLeft: "3px solid var(--brand)",
  borderRadius: "0 8px 8px 0",
  marginBottom: "14px",
  fontFamily: "'SF Mono', Menlo, Consolas, monospace",
  fontSize: "12px",
  lineHeight: 1.55,
  overflow: "hidden",
};

const HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  padding: "8px 12px",
  cursor: "pointer",
  userSelect: "none",
};

const PRE: CSSProperties = {
  margin: 0,
  padding: "10px 14px",
  background: "var(--code-bg)",
  color: "var(--code-text)",
  fontFamily: "inherit",
  fontSize: "11px",
  lineHeight: 1.6,
  whiteSpace: "pre",
  overflow: "auto",
  maxHeight: "240px",
};

const LABEL: CSSProperties = {
  padding: "4px 14px 2px",
  fontSize: "10px",
  fontWeight: 600,
  textTransform: "uppercase",
  color: "var(--text-secondary)",
  letterSpacing: "0.06em",
  background: "var(--bg-page)",
};

export function ToolCallBlock({ call }: { call: ChatToolCall }) {
  const status: NonNullable<ChatToolCall["status"]> = call.status ?? "ok";
  const s = STATUS_STYLE[status];

  // Default: collapsed when `ok`, expanded when `pending` (show running
  // spinner context) or `err` (make the error immediately visible).
  const [open, setOpen] = useState<boolean>(status !== "ok");

  return (
    <div
      data-testid="chat-tool-block"
      data-tool={call.tool}
      data-status={status}
      data-open={open || undefined}
      style={BLOCK}
    >
      <div style={HEADER} onClick={() => setOpen((v) => !v)}>
        <Icon
          name="code"
          size={14}
          style={{ color: "var(--text-secondary)", flexShrink: 0 }}
        />
        <span
          style={{
            fontWeight: 600,
            color: "var(--text-primary)",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {call.tool}
        </span>
        <span
          style={{
            padding: "2px 8px",
            borderRadius: "10px",
            fontSize: "10px",
            fontWeight: 700,
            background: s.bg,
            color: s.fg,
            fontFamily: "'Inter', sans-serif",
            letterSpacing: "0.02em",
            flexShrink: 0,
            lineHeight: 1.4,
          }}
        >
          {i18n.t(s.label)}
        </span>
        <Icon
          name={open ? "chevron-up" : "chevron-down"}
          size={14}
          style={{ color: "var(--text-secondary)", flexShrink: 0 }}
        />
      </div>

      {open ? (
        <>
          <div style={LABEL}>{i18n.t("chat.tool.args")}</div>
          <pre style={PRE}>{call.args || "{}"}</pre>
          {status === "err" ? (
            <>
              <div style={{ ...LABEL, color: "var(--brand)" }}>
                {i18n.t("chat.tool.error")}
              </div>
              <pre style={{ ...PRE, color: "var(--danger)" }}>
                {call.error ?? "Unknown error"}
              </pre>
            </>
          ) : call.result ? (
            <>
              <div style={LABEL}>{i18n.t("chat.tool.result")}</div>
              <pre style={PRE}>{call.result}</pre>
            </>
          ) : status === "pending" ? (
            <div style={{ ...LABEL, fontStyle: "italic" }}>
              {i18n.t("chat.tool.pending")}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
