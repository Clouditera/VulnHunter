/**
 * Splitter — vertical draggable divider between two-column layouts.
 *
 * Usage:
 *   const [width, setWidth] = useResizableWidth("findings-left", 260, { min: 200, max: 600 });
 *   <div style={{ display: "flex" }}>
 *     <div style={{ width }}>...</div>
 *     <Splitter onResize={setWidth} value={width} min={200} max={600} containerRef={...} />
 *     <div style={{ flex: 1 }}>...</div>
 *   </div>
 *
 * Persists width to localStorage under the given storage key.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import type { CSSProperties } from "react";

interface SplitterProps {
  /** Current left-panel width in px */
  value: number;
  /** Called with the new width while dragging */
  onResize: (next: number) => void;
  min?: number;
  max?: number;
  /** Optional ref to the wrapping flex container — if provided, width is computed
      relative to its left edge so the splitter works inside scrollable parents. */
  containerRef?: React.RefObject<HTMLElement | null>;
}

export function Splitter({ value, onResize, min = 200, max = 600, containerRef }: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  const startRef = useRef<{ x: number; w: number } | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startRef.current = { x: e.clientX, w: value };
      setDragging(true);
    },
    [value],
  );

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      if (!startRef.current) return;
      let next: number;
      if (containerRef?.current) {
        const rect = containerRef.current.getBoundingClientRect();
        next = e.clientX - rect.left;
      } else {
        const dx = e.clientX - startRef.current.x;
        next = startRef.current.w + dx;
      }
      next = Math.max(min, Math.min(max, next));
      onResize(next);
    };

    const onUp = () => {
      startRef.current = null;
      setDragging(false);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, min, max, onResize, containerRef]);

  const active = dragging || hover;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="拖动调整宽度"
      style={SPLITTER_STYLE}
    >
      {/* Visible center bar */}
      <div
        style={{
          width: "1px",
          height: "100%",
          background: active ? "var(--brand)" : "var(--divider)",
          transition: "background 0.12s",
        }}
      />
      {/* Grip dots — only show on hover/drag */}
      {active && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            display: "flex",
            flexDirection: "column",
            gap: "2px",
            pointerEvents: "none",
          }}
        >
          <span style={GRIP_DOT} />
          <span style={GRIP_DOT} />
          <span style={GRIP_DOT} />
        </div>
      )}
    </div>
  );
}

const SPLITTER_STYLE: CSSProperties = {
  flexShrink: 0,
  width: "7px",
  cursor: "col-resize",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  position: "relative",
  background: "transparent",
  zIndex: 2,
};

const GRIP_DOT: CSSProperties = {
  width: "3px",
  height: "3px",
  borderRadius: "50%",
  background: "var(--brand)",
};

/* ────────────────────────────────────────────────────────────────────────── */
/*  Persistence hook                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

interface ResizableOpts {
  min?: number;
  max?: number;
}

/**
 * Reads/writes width to localStorage under the given key.
 * Returns [width, setWidth] tuple. Width is clamped to [min, max].
 */
export function useResizableWidth(
  storageKey: string,
  defaultValue: number,
  opts: ResizableOpts = {},
): [number, (n: number) => void] {
  const min = opts.min ?? 200;
  const max = opts.max ?? 600;

  const [width, setWidthState] = useState<number>(() => {
    if (typeof window === "undefined") return defaultValue;
    const saved = window.localStorage.getItem(storageKey);
    if (saved) {
      const n = Number(saved);
      if (!Number.isNaN(n)) return Math.max(min, Math.min(max, n));
    }
    return defaultValue;
  });

  const setWidth = useCallback(
    (n: number) => {
      const clamped = Math.max(min, Math.min(max, n));
      setWidthState(clamped);
      try {
        window.localStorage.setItem(storageKey, String(clamped));
      } catch {
        /* ignore storage failures */
      }
    },
    [storageKey, min, max],
  );

  return [width, setWidth];
}
