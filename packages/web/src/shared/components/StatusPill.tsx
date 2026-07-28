import { i18n } from "../i18n/index.js";

/**
 * Rounded capsule badge for task/scan status.
 * Matches prototype: soft-tinted bg + colored text, 2px·8px padding, 12px radius.
 * States with a running dot get a pulse.
 */
type State = "running" | "preparing" | "completed" | "failed" | "queued" | "cancelled" | "paused";

const STATE_STYLES: Record<State, { bg: string; fg: string; dot?: boolean }> = {
  running: { bg: "rgba(40, 209, 255, 0.14)", fg: "var(--text-primary)", dot: true },
  preparing: { bg: "rgba(41, 140, 255, 0.12)", fg: "var(--brand)", dot: true },
  completed: { bg: "rgba(58, 209, 134, 0.12)", fg: "var(--text-primary)" },
  failed: { bg: "var(--danger-soft)", fg: "var(--danger)" },
  queued: { bg: "rgba(247, 197, 48, 0.14)", fg: "var(--text-primary)" },
  cancelled: { bg: "rgba(97, 109, 126, 0.14)", fg: "var(--text-secondary)" },
  paused: { bg: "rgba(255, 115, 60, 0.12)", fg: "var(--sev-high)" },
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
            background: state === "running" ? "var(--status-running)" : style.fg,
            display: "inline-block",
            animation: "va-pulse 1.4s ease-in-out infinite",
          }}
        />
      )}
      {label}
    </span>
  );
}

// Keyframes injected once globally — safe to include inline in a shared module.
if (typeof document !== "undefined" && !document.getElementById("va-pulse-keyframes")) {
  const styleTag = document.createElement("style");
  styleTag.id = "va-pulse-keyframes";
  styleTag.textContent = `@keyframes va-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }`;
  document.head.appendChild(styleTag);
}
