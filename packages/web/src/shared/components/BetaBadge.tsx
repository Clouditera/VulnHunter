import type { CSSProperties } from "react";

/**
 * Product channel marker — beta pre-release tag (fish 2026-08-18).
 * Amber hue matches the existing --sev-low / --bg-warning family (#f7c530);
 * solid fill + dark text keeps contrast on every surface (dark nav, light/dark
 * themed panels) without theme branching. Remove all usages at GA.
 */
export function BetaBadge({ variant = "pill" }: { variant?: "pill" | "dot" }) {
  if (variant === "dot") {
    // Collapsed sidebar marker — decorative; the full "Beta" label lives in the button tooltip.
    return <span data-testid="beta-badge-dot" aria-hidden="true" style={DOT} />;
  }
  return (
    <span data-testid="beta-badge" style={PILL}>
      Beta
    </span>
  );
}

const PILL: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  flexShrink: 0,
  padding: "1px 5px",
  borderRadius: "999px",
  background: "#f7c530",
  color: "#241a02",
  fontSize: "9px",
  fontWeight: 700,
  letterSpacing: "0.08em",
  lineHeight: 1.5,
  textTransform: "uppercase",
};

const DOT: CSSProperties = {
  position: "absolute",
  top: "-2px",
  right: "-2px",
  width: "6px",
  height: "6px",
  borderRadius: "999px",
  background: "#f7c530",
  border: "1.5px solid #111",
};
