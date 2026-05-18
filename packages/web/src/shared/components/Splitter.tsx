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
  /** Current panel size in px (width for axis="x", height for axis="y") */
  value: number;
  /** Called with the new size while dragging */
  onResize: (next: number) => void;
  min?: number;
  max?: number;
  /** "x" = vertical splitter line dividing left/right (default).
      "y" = horizontal splitter line dividing top/bottom. */
  axis?: "x" | "y";
  /** Optional ref to the wrapping flex container — if provided, size is computed
      relative to its top-left edge (handles scrollable parents correctly). */
  containerRef?: React.RefObject<HTMLElement | null>;
  invert?: boolean;
}

export function Splitter({ value, onResize, min = 200, max = 600, axis = "x", containerRef, invert = false }: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  const startRef = useRef<{ pos: number; size: number } | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startRef.current = { pos: axis === "x" ? e.clientX : e.clientY, size: value };
      setDragging(true);
    },
    [value, axis],
  );

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      if (!startRef.current) return;
      let next: number;
      if (containerRef?.current) {
        const rect = containerRef.current.getBoundingClientRect();
        if (axis === "x") {
          next = invert ? rect.right - e.clientX : e.clientX - rect.left;
        } else {
          next = invert ? rect.bottom - e.clientY : e.clientY - rect.top;
        }
      } else {
        const delta = (axis === "x" ? e.clientX : e.clientY) - startRef.current.pos;
        next = startRef.current.size + (invert ? -delta : delta);
      }
      next = Math.max(min, Math.min(max, next));
      onResize(next);
    };

    const onUp = () => {
      startRef.current = null;
      setDragging(false);
    };

    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, axis, min, max, onResize, containerRef, invert]);

  const active = dragging || hover;
  const isX = axis === "x";

  return (
    <div
      role="separator"
      aria-orientation={isX ? "vertical" : "horizontal"}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="拖动调整尺寸"
      style={{
        flexShrink: 0,
        cursor: isX ? "col-resize" : "row-resize",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        background: "transparent",
        zIndex: 2,
        ...(isX ? { width: "7px" } : { height: "7px" }),
      }}
    >
      {/* Visible center line */}
      <div
        style={{
          background: active ? "var(--brand)" : "var(--divider)",
          transition: "background 0.12s",
          ...(isX ? { width: "1px", height: "100%" } : { height: "1px", width: "100%" }),
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
            flexDirection: isX ? "column" : "row",
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
