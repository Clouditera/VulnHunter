import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

type PendingConfirm = {
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
};

type Listener = (pending: PendingConfirm | null) => void;

const listeners = new Set<Listener>();
const queue: PendingConfirm[] = [];
let current: PendingConfirm | null = null;

function emit() {
  for (const listener of listeners) listener(current);
}

function showNext() {
  if (current || queue.length === 0) return;
  current = queue.shift() ?? null;
  emit();
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ options, resolve });
    showNext();
  });
}

function settle(confirmed: boolean) {
  const pending = current;
  if (!pending) return;
  current = null;
  pending.resolve(confirmed);
  showNext();
  emit();
}

export const CONFIRM_OVERLAY_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  background: "rgba(0,0,0,0.45)",
  zIndex: 3000,
};

const DIALOG_STYLE: CSSProperties = {
  width: 420,
  maxWidth: "100%",
  padding: 24,
  borderRadius: 12,
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
  color: "var(--text-primary)",
};

const BUTTON_STYLE: CSSProperties = {
  padding: "8px 18px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

export function ConfirmHost() {
  const [pending, setPending] = useState<PendingConfirm | null>(current);

  useEffect(() => {
    listeners.add(setPending);
    setPending(current);
    return () => {
      listeners.delete(setPending);
    };
  }, []);

  const cancel = useCallback(() => settle(false), []);
  const accept = useCallback(() => settle(true), []);

  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending, cancel]);

  if (!pending) return null;
  const { options } = pending;

  return (
    <div
      data-testid="confirm-overlay"
      style={CONFIRM_OVERLAY_STYLE}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <div data-testid="confirm-dialog" role="alertdialog" aria-modal="true" style={DIALOG_STYLE}>
        {options.title ? (
          <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>{options.title}</h2>
        ) : null}
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
          {options.message}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 24 }}>
          <button
            type="button"
            data-testid="confirm-cancel"
            onClick={cancel}
            style={{
              ...BUTTON_STYLE,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-primary)",
            }}
          >
            {options.cancelText ?? "取消"}
          </button>
          <button
            type="button"
            data-testid="confirm-accept"
            autoFocus
            onClick={accept}
            style={{
              ...BUTTON_STYLE,
              border: "none",
              background: options.danger ? "var(--danger, #c22828)" : "var(--brand)",
              color: "#fff",
            }}
          >
            {options.confirmText ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
