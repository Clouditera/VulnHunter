import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import { i18n } from "../i18n/index.js";

type BubblePlacement = "top" | "right" | "bottom";

/**
 * Product channel marker — beta pre-release tag (fish 2026-08-18).
 * Restrained logo-blue treatment: var(--brand) text on a var(--brand-soft)
 * tint, no border, no uppercase. Hovering the badge opens a bubble that
 * explains the beta channel (copy per fish). Remove all usages at GA.
 */
export function BetaBadge({
  variant = "pill",
  placement = "top",
  onHoverChange,
}: {
  variant?: "pill" | "dot";
  placement?: BubblePlacement;
  /** Lets a parent suppress its own native tooltip while the bubble is up. */
  onHoverChange?: (hovered: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const hitRef = useRef<HTMLSpanElement>(null);
  // Dot variant: the collapsed nav clips absolutely-positioned overflow, so the
  // bubble escapes via viewport-fixed coordinates measured from the dot.
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const pos = BUBBLE_PLACEMENT[placement];
  const bubblePos: CSSProperties =
    variant === "dot" && anchor
      ? { position: "fixed", left: anchor.x + 8, top: anchor.y }
      : pos.bubble;
  const bubbleTransform =
    variant === "dot"
      ? open ? "translateY(-50%)" : "translateY(-50%) translateX(-3px)"
      : open ? pos.transformOpen : pos.transformClosed;
  const bubble = (
    <span
      data-testid="beta-badge-bubble"
      role="tooltip"
      style={{
        ...BUBBLE_BASE,
        ...bubblePos,
        opacity: open ? 1 : 0,
        visibility: open ? "visible" : "hidden",
        transform: bubbleTransform,
      }}
    >
      <span aria-hidden="true" style={{ ...ARROW_BASE, ...ARROW_PLACEMENT[placement] }} />
      {i18n.t("beta.tooltip")}
    </span>
  );
  const hover = {
    onMouseEnter: () => {
      if (variant === "dot" && hitRef.current) {
        const r = hitRef.current.getBoundingClientRect();
        setAnchor({ x: r.right, y: r.top + r.height / 2 });
      }
      setOpen(true);
      onHoverChange?.(true);
    },
    onMouseLeave: () => { setOpen(false); onHoverChange?.(false); },
  };
  if (variant === "dot") {
    // Collapsed sidebar marker — enlarged invisible hit area around the dot.
    return (
      <span ref={hitRef} data-testid="beta-badge-dot" style={DOT_HIT} {...hover}>
        <span aria-hidden="true" style={DOT} />
        {bubble}
      </span>
    );
  }
  return (
    <span data-testid="beta-badge" style={PILL} {...hover}>
      Beta
      {bubble}
    </span>
  );
}

const PILL: CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  flexShrink: 0,
  padding: "1px 6px",
  borderRadius: "999px",
  background: "var(--brand-soft)",
  color: "var(--brand)",
  fontSize: "10px",
  fontWeight: 600,
  lineHeight: 1.5,
};

// 16×16 hover zone anchored on the chip corner; visible dot sits at (4,4).
const DOT_HIT: CSSProperties = {
  position: "absolute",
  top: "-6px",
  right: "-6px",
  width: "16px",
  height: "16px",
};

const DOT: CSSProperties = {
  position: "absolute",
  top: "4px",
  right: "4px",
  width: "6px",
  height: "6px",
  borderRadius: "999px",
  background: "var(--brand)",
  border: "1.5px solid #111",
};

const BUBBLE_BASE: CSSProperties = {
  position: "absolute",
  width: "232px",
  padding: "10px 12px",
  borderRadius: "10px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
  color: "var(--text-primary)",
  fontSize: "12px",
  fontWeight: 400,
  lineHeight: 1.6,
  textAlign: "left",
  whiteSpace: "normal",
  zIndex: 60,
  pointerEvents: "none",
  transition: "opacity 120ms ease, transform 120ms ease, visibility 120ms",
};

const BUBBLE_PLACEMENT: Record<
  BubblePlacement,
  { bubble: CSSProperties; transformClosed: string; transformOpen: string }
> = {
  top: {
    bubble: { bottom: "calc(100% + 8px)", left: "50%" },
    transformClosed: "translateX(-50%) translateY(3px)",
    transformOpen: "translateX(-50%)",
  },
  right: {
    bubble: { left: "calc(100% + 8px)", top: "50%" },
    transformClosed: "translateY(-50%) translateX(-3px)",
    transformOpen: "translateY(-50%)",
  },
  bottom: {
    bubble: { top: "calc(100% + 8px)", left: "50%" },
    transformClosed: "translateX(-50%) translateY(-3px)",
    transformOpen: "translateX(-50%)",
  },
};

const ARROW_BASE: CSSProperties = {
  position: "absolute",
  width: "8px",
  height: "8px",
  background: "var(--bg-card)",
  transform: "rotate(45deg)",
};

const ARROW_PLACEMENT: Record<BubblePlacement, CSSProperties> = {
  top: { bottom: "-5px", left: "50%", marginLeft: "-4px", borderRight: "1px solid var(--border)", borderBottom: "1px solid var(--border)" },
  right: { left: "-5px", top: "50%", marginTop: "-4px", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)" },
  bottom: { top: "-5px", left: "50%", marginLeft: "-4px", borderLeft: "1px solid var(--border)", borderTop: "1px solid var(--border)" },
};
