/**
 * Global toast notifications — centered viewport stack.
 * Usage: toast.error("…") / toast.success("…") / toast.info("…")
 */

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";

export type ToastKind = "error" | "success" | "info";

type ToastItem = {
  id: number;
  kind: ToastKind;
  message: string;
  ms: number;
};

type Listener = (items: ToastItem[]) => void;

const listeners = new Set<Listener>();
let items: ToastItem[] = [];
let seq = 1;

function emit() {
  for (const l of listeners) l(items);
}

function push(kind: ToastKind, message: string, ms = 4500) {
  const id = seq++;
  items = [...items, { id, kind, message, ms }];
  emit();
  window.setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, ms);
  return id;
}

export const toast = {
  error: (message: string, ms?: number) => push("error", message, ms ?? 5500),
  success: (message: string, ms?: number) => push("success", message, ms ?? 3500),
  info: (message: string, ms?: number) => push("info", message, ms ?? 4000),
  dismiss: (id: number) => {
    items = items.filter((t) => t.id !== id);
    emit();
  },
};

const KIND_STYLE: Record<ToastKind, CSSProperties> = {
  error: {
    background: "var(--bg-card)",
    border: "1px solid rgba(194,40,40,0.45)",
    color: "var(--text-primary)",
    boxShadow: "0 8px 28px rgba(194,40,40,0.18)",
  },
  success: {
    background: "var(--bg-card)",
    border: "1px solid rgba(58,209,134,0.45)",
    color: "var(--text-primary)",
    boxShadow: "0 8px 28px rgba(58,209,134,0.14)",
  },
  info: {
    background: "var(--bg-card)",
    border: "1px solid var(--border)",
    color: "var(--text-primary)",
    boxShadow: "0 8px 28px rgba(0,0,0,0.12)",
  },
};

const ACCENT: Record<ToastKind, string> = {
  error: "var(--danger, #c22828)",
  success: "var(--status-completed, #3ad186)",
  info: "var(--brand)",
};

export const TOAST_HOST_STYLE: CSSProperties = {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  zIndex: 2000,
  display: "flex",
  flexDirection: "column-reverse",
  gap: 10,
  width: "max-content",
  maxWidth: "min(420px, calc(100vw - 40px))",
  pointerEvents: "none",
};

export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    const fn: Listener = (next) => setList(next);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  const dismiss = useCallback((id: number) => toast.dismiss(id), []);

  if (list.length === 0) return null;

  return (
    <div data-testid="toast-host" style={TOAST_HOST_STYLE}>
      {list.map((t) => (
        <div
          key={t.id}
          data-testid={`toast-${t.kind}`}
          role="status"
          style={{
            pointerEvents: "auto",
            display: "flex",
            gap: 12,
            alignItems: "flex-start",
            padding: "12px 14px",
            borderRadius: 10,
            fontSize: 13,
            lineHeight: 1.5,
            animation: "vh-toast-in 0.22s ease-out",
            ...KIND_STYLE[t.kind],
          }}
        >
          <span
            aria-hidden
            style={{
              width: 4,
              alignSelf: "stretch",
              borderRadius: 2,
              background: ACCENT[t.kind],
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>{t.message}</div>
          <button
            type="button"
            aria-label="dismiss"
            onClick={() => dismiss(t.id)}
            style={{
              border: "none",
              background: "transparent",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
              padding: 0,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      ))}
      <style>{`
        @keyframes vh-toast-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
