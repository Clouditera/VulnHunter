import type { CSSProperties } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import type { ChatSession } from "../types.js";

/**
 * Left sidebar (240px) — list of chat sessions + New Chat button.
 *
 * Matches prototype `.chat-sidebar` / `.session-list` / `.session-item`.
 * Hover reveals a small delete button per row; clicking it asks for
 * confirmation before delegating to `onDelete`.
 */

const SIDEBAR: CSSProperties = {
  width: "240px",
  flexShrink: 0,
  borderRight: "1px solid var(--border)",
  background: "var(--bg-page)",
  display: "flex",
  flexDirection: "column",
  height: "100%",
};

const HEADER: CSSProperties = {
  padding: "14px 14px 10px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  borderBottom: "1px solid var(--divider)",
};

const NEW_BTN: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  padding: "5px 10px",
  background: "var(--brand)",
  color: "var(--btn-primary-text)",
  borderRadius: "6px",
  border: "none",
  fontSize: "11px",
  fontWeight: 600,
  cursor: "pointer",
  lineHeight: 1,
};

export function SessionList({
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  sessions: ChatSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside data-testid="chat-sidebar" style={SIDEBAR}>
      <div style={HEADER}>
        <span
          style={{
            fontSize: "14px",
            fontWeight: 700,
            color: "var(--text-primary)",
          }}
        >
          {i18n.t("chat.sidebarTitle")}
        </span>
        <button
          type="button"
          data-testid="chat-new-btn"
          onClick={onNew}
          style={NEW_BTN}
        >
          <Icon name="plus" size={12} strokeWidth={2.5} />
          <span>{i18n.t("chat.newChat")}</span>
        </button>
      </div>

      <div
        data-testid="chat-session-list"
        style={{ flex: 1, overflowY: "auto", padding: "6px" }}
      >
        {sessions.length === 0 ? (
          <div
            style={{
              padding: "24px 12px",
              fontSize: "12px",
              color: "var(--text-secondary)",
              textAlign: "center",
            }}
          >
            {i18n.t("chat.noSession")}
          </div>
        ) : (
          sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === activeId}
              onSelect={() => onSelect(s.id)}
              onDelete={() => {
                const msg = i18n
                  .t("chat.delete.confirm")
                  .replace("{title}", s.title);
                if (window.confirm(msg)) onDelete(s.id);
              }}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      data-testid="chat-session-row"
      data-session-id={session.id}
      data-active={active || undefined}
      onClick={onSelect}
      style={{
        position: "relative",
        padding: "10px 12px",
        borderRadius: "6px",
        cursor: "pointer",
        marginBottom: "2px",
        background: active ? "var(--bg-card)" : "transparent",
        boxShadow: active ? "0 1px 2px rgba(0,0,0,0.06)" : undefined,
        transition: "background 0.12s",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      <div
        style={{
          fontSize: "13px",
          fontWeight: active ? 600 : 500,
          color: active ? "var(--text-primary)" : "var(--text-secondary)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          paddingRight: "18px",
        }}
      >
        {session.title}
      </div>
      <div
        style={{
          fontSize: "11px",
          color: "var(--text-secondary)",
          opacity: 0.75,
          marginTop: "2px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {session.preview ?? formatRelative(session.updated_at)}
      </div>

      {/* Delete affordance — appears on hover (drawn with CSS since we can't
          use `:hover` from inline styles; we fake it with opacity transitions
          driven by parent hover via the onMouse handlers above). */}
      <button
        type="button"
        data-testid="chat-session-delete"
        aria-label={i18n.t("tasks.delete")}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        style={{
          position: "absolute",
          right: "6px",
          top: "50%",
          transform: "translateY(-50%)",
          width: "20px",
          height: "20px",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          background: "transparent",
          color: "var(--text-secondary)",
          borderRadius: "4px",
          cursor: "pointer",
          opacity: 0,
          transition: "opacity 0.12s, color 0.12s",
          padding: 0,
        }}
        /* Visibility is driven entirely by the CSS :hover / :focus-visible
           rules below — do NOT set inline opacity here, or it will stick
           after mouseleave and make the icon visible on non-hovered rows. */
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--brand)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--text-secondary)";
        }}
      >
        <Icon name="trash" size={12} />
      </button>

      {/* Show delete icon when: row is hovered OR button is keyboard-focused.
          React inline styles can't do :hover / :focus-visible — use a
          single <style> block. */}
      <style>{`
        [data-testid="chat-session-row"]:hover [data-testid="chat-session-delete"],
        [data-testid="chat-session-delete"]:focus-visible { opacity: 1 !important; }
      `}</style>
    </div>
  );
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffMs = Date.now() - t;
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}
