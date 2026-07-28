import type { CSSProperties } from "react";
import type { SeverityCounts } from "../api/client.js";

/**
 * Mini severity badges — `2H 5M 3L 2I`.
 * Functional colors for letter; soft tint bg; counts use brand-neutral text via fg color.
 */

const STYLES: Record<keyof SeverityCounts, { bg: string; fg: string; letter: string }> = {
  high: { bg: "rgba(242,79,79,0.12)", fg: "var(--sev-high)", letter: "H" },
  medium: { bg: "rgba(255,115,60,0.12)", fg: "var(--sev-medium)", letter: "M" },
  low: { bg: "rgba(247,197,48,0.15)", fg: "var(--text-secondary)", letter: "L" },
  info: { bg: "rgba(156,163,175,0.15)", fg: "var(--sev-info)", letter: "I" },
};

const BADGE_BASE: CSSProperties = {
  padding: "2px 6px",
  borderRadius: "3px",
  fontSize: "10px",
  fontWeight: 700,
  lineHeight: 1.4,
  fontFamily: "var(--font-mono)",
};

export function SeverityBadges({
  counts,
  testid,
}: {
  counts: SeverityCounts;
  testid?: string;
}) {
  const total = counts.high + counts.medium + counts.low + counts.info;
  if (total === 0) return null;

  const order: Array<keyof SeverityCounts> = ["high", "medium", "low", "info"];

  return (
    <span
      data-testid={testid}
      style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}
    >
      {order.map((sev) => {
        const n = counts[sev];
        if (!n) return null;
        const s = STYLES[sev];
        return (
          <span
            key={sev}
            data-severity={sev}
            style={{ ...BADGE_BASE, background: s.bg, color: s.fg }}
          >
            {n}
            {s.letter}
          </span>
        );
      })}
    </span>
  );
}
