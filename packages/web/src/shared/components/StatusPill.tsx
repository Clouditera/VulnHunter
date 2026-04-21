import { i18n } from "../i18n/index.js";

/**
 * Rounded capsule badge for task/scan status.
 * Matches prototype: soft-tinted bg + colored text, 2px·8px padding, 12px radius.
 * States with a running dot get a pulse.
 */
type State = "running" | "completed" | "failed" | "queued" | "cancelled" | "paused";

const STATE_STYLES: Record<State, { bg: string; fg: string; dot?: boolean }> = {
  running: { bg: "rgba(37, 99, 235, 0.12)", fg: "#2563eb", dot: true },
  completed: { bg: "rgba(22, 163, 74, 0.12)", fg: "#166534" },
  failed: { bg: "rgba(220, 38, 38, 0.12)", fg: "#dc2626" },
  queued: { bg: "rgba(202, 138, 4, 0.12)", fg: "#92400e" },
  cancelled: { bg: "rgba(115, 115, 115, 0.14)", fg: "#525252" },
  paused: { bg: "rgba(234, 88, 12, 0.12)", fg: "#ea580c" },
};

export function StatusPill({ state, size = "md" }: { state: string; size?: "sm" | "md" }) {
  const style = STATE_STYLES[state as State] ?? STATE_STYLES.cancelled;
  const label = i18n.t(`tasks.status.${state}`);
  const padding = size === "sm" ? "2px 8px" : "3px 10px";
  const fontSize = size === "sm" ? "11px" : "12px";
  return (
    <span
      data-status={state}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding,
        borderRadius: "12px",
        background: style.bg,
        color: style.fg,
        fontSize,
        fontWeight: 600,
        lineHeight: 1.4,
        letterSpacing: "0.01em",
        whiteSpace: "nowrap",
      }}
    >
      {style.dot && (
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: style.fg,
            display: "inline-block",
            animation: "vh-pulse 1.4s ease-in-out infinite",
          }}
        />
      )}
      {label}
    </span>
  );
}

// Keyframes injected once globally — safe to include inline in a shared module.
if (typeof document !== "undefined" && !document.getElementById("vh-pulse-keyframes")) {
  const styleTag = document.createElement("style");
  styleTag.id = "vh-pulse-keyframes";
  styleTag.textContent = `@keyframes vh-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }`;
  document.head.appendChild(styleTag);
}
