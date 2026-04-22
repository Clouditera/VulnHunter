import { useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";

/**
 * Bottom input bar for the chat center pane.
 *
 * Single-row textarea that auto-grows up to 5 lines, then scrolls.
 * Enter submits; Shift+Enter inserts a newline. While the assistant is
 * streaming, the send button is replaced by a red Stop button that
 * calls `onAbort`.
 */

const WRAP: CSSProperties = {
  flexShrink: 0,
  background: "var(--bg-card)",
  borderTop: "1px solid var(--border)",
  padding: "12px 24px 14px",
};

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: "10px",
};

const TEXTAREA_BASE: CSSProperties = {
  flex: 1,
  minHeight: "40px",
  maxHeight: "140px",
  padding: "10px 14px",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  fontSize: "14px",
  fontFamily: "inherit",
  color: "var(--text-primary)",
  background: "var(--bg-page)",
  outline: "none",
  resize: "none",
  lineHeight: 1.5,
  transition: "border-color 0.12s",
  boxSizing: "border-box",
};

const BTN: CSSProperties = {
  width: "40px",
  height: "40px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  borderRadius: "8px",
  cursor: "pointer",
  flexShrink: 0,
  transition: "background 0.12s",
};

export function ChatInput({
  streaming,
  onSend,
  onAbort,
  disabled,
}: {
  streaming: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  function resizeTextarea() {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    if (streaming || disabled) return;
    const v = text.trim();
    if (!v) return;
    onSend(v);
    setText("");
    // Reset textarea height
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "40px";
    });
  }

  const canSend = !streaming && !disabled && text.trim().length > 0;

  return (
    <div data-testid="chat-input-wrap" style={WRAP}>
      <div style={ROW}>
        <textarea
          ref={taRef}
          data-testid="chat-input-textarea"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            resizeTextarea();
          }}
          onKeyDown={handleKeyDown}
          placeholder={i18n.t("chat.inputPlaceholder")}
          rows={1}
          disabled={disabled}
          style={TEXTAREA_BASE}
          onFocus={(e) => (e.currentTarget.style.borderColor = "var(--brand)")}
          onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
        />

        {streaming ? (
          <button
            type="button"
            data-testid="chat-abort-btn"
            onClick={onAbort}
            title={i18n.t("chat.abort")}
            style={{
              ...BTN,
              background: "var(--bg-error)",
              color: "var(--brand)",
              border: "1px solid rgba(220,38,38,0.3)",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "rgba(220,38,38,0.18)")
            }
            onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg-error)")}
          >
            <Icon name="x" size={16} strokeWidth={2.5} />
          </button>
        ) : (
          <button
            type="button"
            data-testid="chat-send-btn"
            onClick={submit}
            disabled={!canSend}
            title={i18n.t("chat.send")}
            style={{
              ...BTN,
              background: canSend ? "var(--brand)" : "var(--bg-disabled)",
              color: canSend ? "#fff" : "var(--text-secondary)",
              cursor: canSend ? "pointer" : "not-allowed",
              opacity: canSend ? 1 : 0.6,
            }}
          >
            <Icon name="chevron-right" size={16} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}
