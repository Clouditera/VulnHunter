import type { CSSProperties } from "react";
import type { ChatActivity } from "../types.js";

export function ChatActivityBar({ activity }: { activity?: ChatActivity | null }) {
  if (!activity) return null;
  return (
    <div style={{ padding: "0 24px 8px" }}>
      <div data-testid="chat-activity-bar" style={BAR}>
        <StatusIcon status={activity.status} />
        <span data-testid="chat-activity-current" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {activity.label}
        </span>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: ChatActivity["status"] }) {
  if (status === "running") return <span style={{ ...DOT, background: "var(--brand)", animation: "vh-caret-blink 1s infinite" }} />;
  if (status === "success") return <span style={{ color: "#16a34a", fontSize: 12 }}>✓</span>;
  if (status === "warning") return <span style={{ color: "#d97706", fontSize: 12 }}>!</span>;
  if (status === "waiting") return <span style={{ ...DOT, background: "#d97706" }} />;
  return <span style={{ ...DOT, background: "var(--text-secondary)" }} />;
}

const BAR: CSSProperties = {
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
  fontSize: 12,
};

const DOT: CSSProperties = { display: "inline-block", width: 9, height: 9, borderRadius: "50%", flexShrink: 0 };
