import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface PromptOptions extends ConfirmOptions {
  defaultValue?: string;
}

type PendingDialog =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void };
type Listener = (pending: PendingDialog | null) => void;

const listeners = new Set<Listener>();
const queue: PendingDialog[] = [];
let current: PendingDialog | null = null;

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
    queue.push({ kind: "confirm", options, resolve });
    showNext();
  });
}

export function prompt(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({ kind: "prompt", options, resolve });
    showNext();
  });
}

function settle(value: boolean | string | null) {
  const pending = current;
  if (!pending) return;
  current = null;
  if (pending.kind === "confirm") pending.resolve(value === true);
  else pending.resolve(typeof value === "string" ? value : null);
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
  const [pending, setPending] = useState<PendingDialog | null>(current);
  const [input, setInput] = useState("");

  useEffect(() => {
    const listener: Listener = (next) => {
      setPending(next);
      setInput(next?.kind === "prompt" ? (next.options.defaultValue ?? "") : "");
    };
    listeners.add(listener);
    listener(current);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const cancel = useCallback(() => settle(null), []);
  const accept = useCallback(
    () => settle(pending?.kind === "prompt" ? input : true),
    [pending, input],
  );

  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending, cancel]);

  if (!pending) return null;
  return (
    <div
      data-testid="confirm-overlay"
      style={CONFIRM_OVERLAY_STYLE}
      onMouseDown={(event) => event.target === event.currentTarget && cancel()}
    >
      <div data-testid="confirm-dialog" role="alertdialog" aria-modal="true" style={DIALOG_STYLE}>
        {pending.options.title ? (
          <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>{pending.options.title}</h2>
        ) : null}
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
          {pending.options.message}
        </p>
        {pending.kind === "prompt" ? (
          <input
            autoFocus
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && accept()}
            style={{
              width: "100%",
              boxSizing: "border-box",
              marginTop: 16,
              padding: "9px 12px",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg-page)",
              color: "var(--text-primary)",
            }}
          />
        ) : null}
        <DialogActions
          options={pending.options}
          accept={accept}
          cancel={cancel}
          autoFocus={pending.kind === "confirm"}
        />
      </div>
    </div>
  );
}

function DialogActions({
  options,
  accept,
  cancel,
  autoFocus,
}: { options: ConfirmOptions; accept: () => void; cancel: () => void; autoFocus: boolean }) {
  return (
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
        autoFocus={autoFocus}
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
  );
}
