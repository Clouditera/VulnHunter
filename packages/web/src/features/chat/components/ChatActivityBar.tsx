import { useState } from "react";
import type { CSSProperties } from "react";
import type { ChatActivity } from "../types.js";

export function ChatActivityBar({ activity, recent }: { activity?: ChatActivity | null; recent: ChatActivity[] }) {
  const [open, setOpen] = useState(false);
  if (!activity) return null;
  const completed = recent.filter((a) => a.status === "success").length;
  return (
    <div style={{ position: "relative", padding: "0 24px 8px" }}>
      <button
        type="button"
        data-testid="chat-activity-bar"
        onClick={() => setOpen((v) => !v)}
        style={BAR}
      >
        <StatusIcon status={activity.status} />
        <span data-testid="chat-activity-current" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
          {activity.label}
        </span>
        {completed > 0 ? <span style={COUNT}>已完成 {completed} 项</span> : null}
      </button>
      {open && recent.length > 0 ? (
        <div data-testid="chat-activity-recent" style={POPOVER}>
          {recent.slice(-3).map((item) => (
            <div key={item.id} style={RECENT_ROW}>
              <StatusIcon status={item.status} small />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StatusIcon({ status, small }: { status: ChatActivity["status"]; small?: boolean }) {
  const size = small ? 7 : 9;
  if (status === "running") return <span style={{ ...DOT, width: size, height: size, background: "var(--brand)", animation: "vh-caret-blink 1s infinite" }} />;
  if (status === "success") return <span style={{ color: "#16a34a", fontSize: small ? 11 : 12 }}>✓</span>;
  if (status === "warning") return <span style={{ color: "#d97706", fontSize: small ? 11 : 12 }}>!</span>;
  if (status === "waiting") return <span style={{ ...DOT, width: size, height: size, background: "#d97706" }} />;
  return <span style={{ ...DOT, width: size, height: size, background: "var(--text-secondary)" }} />;
}

const BAR: CSSProperties = {
  width: "100%",
  minHeight: 34,
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "7px 11px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: "inherit",
};

const DOT: CSSProperties = { display: "inline-block", borderRadius: "50%", flexShrink: 0 };
const COUNT: CSSProperties = { color: "var(--text-secondary)", fontSize: 11, flexShrink: 0 };
const POPOVER: CSSProperties = { position: "absolute", left: 24, right: 24, bottom: "calc(100% + 4px)", zIndex: 30, padding: 8, borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg-card)", boxShadow: "0 8px 24px rgba(0,0,0,0.12)", display: "flex", flexDirection: "column", gap: 6 };
const RECENT_ROW: CSSProperties = { display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: 12, minWidth: 0 };
