import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ClipboardEvent, DragEvent, KeyboardEvent } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { api } from "../../../shared/api/client.js";
import type { ChatImageAttachment } from "../types.js";

/**
 * Bottom input bar for the chat center pane.
 *
 * Supports:
 *   - Enter submits; Shift+Enter inserts newline
 *   - Paste screenshots (Cmd+V / Ctrl+V on a copied image)
 *   - Drag & drop image files onto the whole input area
 *   - File-picker button (paperclip) for manual selection
 *   - Thumbnail preview row above the textarea with × to remove
 *
 * ## Attachment wire format (per Architect's revised design)
 *
 * Files are NOT base64'd into the prompt. Instead:
 *   1. On submit, each pending file is POSTed to
 *      `POST /api/chat/sessions/:id/upload` (multipart, field=`file`).
 *   2. Server stores under the session's attachments dir and returns
 *      `{ artifact_id, path: "/workspace/chat-session/attachments/<hash>.png",
 *         originalFilename: "screenshot.png" }`.
 *   3. We prepend `Attachment: [artifact_id: <uuid>; original filename: x.png](<path>)` lines
 *      to the user's text and send the whole thing as a plain prompt.
 *   4. pi's `read` tool opens the file natively.
 *
 * This matches bossmode's MessageInput pattern, keeps RPC messages small,
 * and lets the agent re-read the file later.
 *
 * While the assistant is streaming, the send button is replaced by a red
 * Stop button. While an upload is in-flight, the send button shows an
 * "uploading" label instead of the arrow.
 */

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** Per-file hard cap (500 MB). Matches backend upload limit. */
const MAX_FILE_BYTES = 500 * 1024 * 1024;
/** Max attachments per message. */
const MAX_ATTACHMENTS = 8;

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface PendingFile {
  file: File;
  /** Blob URL for <img src> (for image/*). Empty string for non-images. */
  preview: string;
  /** Displayed name. */
  name: string;
  /** True when the file is an image (preview is renderable). */
  isImage: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Styles                                                                    */
/* -------------------------------------------------------------------------- */

const WRAP: CSSProperties = {
  flexShrink: 0,
  background: "var(--bg-card)",
  borderTop: "1px solid var(--border)",
  padding: "12px 24px 14px",
  transition: "background 0.15s",
};

const WRAP_DRAGOVER: CSSProperties = {
  background: "var(--bg-page)",
  boxShadow: "inset 0 0 0 2px var(--brand)",
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

const THUMB_ROW: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px",
  marginBottom: "10px",
};

const THUMB: CSSProperties = {
  position: "relative",
  width: "56px",
  height: "56px",
  borderRadius: "8px",
  border: "1px solid var(--border)",
  background: "var(--bg-page)",
  overflow: "hidden",
  flexShrink: 0,
};

const THUMB_NON_IMAGE: CSSProperties = {
  ...THUMB,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "4px 6px",
  color: "var(--text-secondary)",
  fontSize: "9px",
  lineHeight: 1.15,
  textAlign: "center",
  wordBreak: "break-all",
};

const THUMB_REMOVE: CSSProperties = {
  position: "absolute",
  top: "-6px",
  right: "-6px",
  width: "18px",
  height: "18px",
  borderRadius: "50%",
  background: "var(--text-primary)",
  color: "#fff",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "2px solid var(--bg-card)",
  cursor: "pointer",
  padding: 0,
  lineHeight: 1,
};

const HINT: CSSProperties = {
  marginTop: "4px",
  fontSize: "11px",
  color: "var(--text-secondary)",
};

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function ChatInput({
  sessionId,
  streaming,
  onSend,
  onAbort,
  onEnsureSession,
  disabled,
}: {
  sessionId: string | null;
  streaming: boolean;
  onSend: (text: string, images?: ChatImageAttachment[]) => void;
  onAbort: () => void;
  onEnsureSession?: () => Promise<string | null>;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Drag events fire on children too; track depth to avoid flicker.
  const dragDepth = useRef(0);

  // Revoke object URLs on unmount / replacement.
  useEffect(() => {
    return () => {
      pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onSuggest = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; submit?: boolean }>).detail;
      const value = detail?.text;
      if (!value) return;
      if (detail?.submit) {
        onSend(value);
        setText("");
        requestAnimationFrame(() => {
          if (taRef.current) taRef.current.style.height = "40px";
        });
        return;
      }
      setText(value);
      requestAnimationFrame(() => {
        resizeTextarea();
        taRef.current?.focus();
      });
    };
    window.addEventListener("vh:chat-suggest", onSuggest);
    return () => window.removeEventListener("vh:chat-suggest", onSuggest);
  }, [onSend]);

  function resizeTextarea() {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  /* -------------------------------- Attachments ------------------------- */

  function addFiles(files: FileList | File[]) {
    if (disabled || streaming || uploading) return;
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const oversized = incoming.find((f) => f.size > MAX_FILE_BYTES);
    if (oversized) {
      setAttachError(
        i18n
          .t("chat.attach.errOversize")
          .replace("{name}", oversized.name)
          .replace("{limit}", "500 MB"),
      );
      return;
    }
    const slots = MAX_ATTACHMENTS - pending.length;
    if (slots <= 0) {
      setAttachError(i18n.t("chat.attach.errTooMany").replace("{n}", String(MAX_ATTACHMENTS)));
      return;
    }
    const next: PendingFile[] = incoming.slice(0, slots).map((f) => {
      const isImage = /^image\//i.test(f.type);
      return {
        file: f,
        preview: isImage ? URL.createObjectURL(f) : "",
        name: f.name || clipboardFallbackName(f.type),
        isImage,
      };
    });
    setPending((prev) => [...prev, ...next]);
    setAttachError(null);
  }

  function removeAttachment(idx: number) {
    setPending((prev) => {
      const removed = prev[idx];
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== idx);
    });
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const raw = it.getAsFile();
        if (!raw) continue;
        // Clipboard images arrive with name "" — give them a stable name
        // so the server's attachment log is readable.
        const named = new File([raw], clipboardFallbackName(raw.type), {
          type: raw.type,
        });
        files.push(named);
      }
    }
    if (files.length > 0) {
      e.preventDefault(); // don't paste garbled binary into textarea
      addFiles(files);
    }
  }

  function handleDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!hasFilesInDataTransfer(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  }
  function handleDragLeave(_e: DragEvent<HTMLDivElement>) {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }
  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    if (hasFilesInDataTransfer(e)) e.preventDefault(); // enables drop
  }
  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) addFiles(files);
  }

  /* -------------------------------- Submit ------------------------------ */

  async function submit() {
    if (streaming || disabled || uploading) return;
    const trimmed = text.trim();
    if (!trimmed && pending.length === 0) return;

    // Resolve the session id to upload against. In a brand-new conversation the
    // session is still a "draft" placeholder (sessionId === null) — materialize
    // it into a real UUID session first, otherwise the upload would POST to
    // /sessions/draft/upload and the backend would 500 on the invalid uuid.
    let uploadSessionId = sessionId;
    if (pending.length > 0 && !uploadSessionId) {
      if (onEnsureSession) {
        uploadSessionId = await onEnsureSession();
      }
      if (!uploadSessionId) {
        setAttachError(i18n.t("chat.attach.errNoSession"));
        return;
      }
    }

    let content = trimmed;
    let attachImages: ChatImageAttachment[] | undefined;

    if (pending.length > 0 && uploadSessionId) {
      setUploading(true);
      setAttachError(null);
      try {
        const lines: string[] = [];
        const imgs: ChatImageAttachment[] = [];
        for (const pf of pending) {
          const res = await api.chat.sessions.upload(uploadSessionId, pf.file);
          lines.push(
            `Attachment: [artifact_id: ${res.artifact_id}; original filename: ${res.originalName}](${res.path})`,
          );
          if (pf.isImage) {
            imgs.push({
              preview: pf.preview,
              name: pf.name,
              mimeType: pf.file.type,
              path: res.path,
            });
          }
        }
        const attachText = lines.join("\n");
        content = content ? `${content}\n${attachText}` : attachText;
        attachImages = imgs.length > 0 ? imgs : undefined;
      } catch (err) {
        setUploading(false);
        setAttachError(
          i18n.t("chat.attach.errUpload").replace("{msg}", (err as Error)?.message ?? "unknown"),
        );
        return;
      }
      // Hand previews over to the rendered message — DO NOT revoke here.
      // MessageBubble keeps them alive; they're revoked on unmount.
      setPending([]);
      setUploading(false);
    }

    onSend(content, attachImages);
    setText("");
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "40px";
    });
  }

  const canSend =
    !streaming && !disabled && !uploading && (text.trim().length > 0 || pending.length > 0);

  const attachBtnDisabled = disabled || streaming || uploading;

  return (
    <div
      data-testid="chat-input-wrap"
      style={{ ...WRAP, ...(dragOver ? WRAP_DRAGOVER : null) }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Thumbnail preview row */}
      {pending.length > 0 ? (
        <div data-testid="chat-attachments" style={THUMB_ROW}>
          {pending.map((pf, i) => (
            <div key={i} style={pf.isImage ? THUMB : THUMB_NON_IMAGE} title={pf.name}>
              {pf.isImage ? (
                <img
                  src={pf.preview}
                  alt={pf.name}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : (
                <>
                  <Icon name="file" size={18} />
                  <span
                    style={{
                      marginTop: "3px",
                      maxWidth: "100%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {pf.name}
                  </span>
                </>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(i)}
                aria-label={i18n.t("chat.attach.remove")}
                style={THUMB_REMOVE}
              >
                <Icon name="x" size={10} strokeWidth={3} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div style={ROW}>
        {/* Hidden file picker */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = ""; // allow re-picking same file
          }}
        />
        <button
          type="button"
          data-testid="chat-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={attachBtnDisabled}
          title={i18n.t("chat.attach.pick")}
          style={{
            ...BTN,
            background: "transparent",
            color: "var(--text-secondary)",
            border: "1px solid var(--border)",
            cursor: attachBtnDisabled ? "not-allowed" : "pointer",
            opacity: attachBtnDisabled ? 0.5 : 1,
          }}
          onMouseEnter={(e) => {
            if (attachBtnDisabled) return;
            e.currentTarget.style.background = "var(--bg-page)";
            e.currentTarget.style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--text-secondary)";
          }}
        >
          <Icon name="paperclip" size={16} strokeWidth={2} />
        </button>

        <textarea
          ref={taRef}
          data-testid="chat-input-textarea"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            resizeTextarea();
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            uploading ? i18n.t("chat.attach.uploading") : i18n.t("chat.inputPlaceholder")
          }
          rows={1}
          disabled={disabled || uploading}
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
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(220,38,38,0.18)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg-error)")}
          >
            <Icon name="x" size={16} strokeWidth={2.5} />
          </button>
        ) : (
          <button
            type="button"
            data-testid="chat-send-btn"
            onClick={() => void submit()}
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
            {uploading ? (
              <Icon name="loader" size={16} strokeWidth={2.5} />
            ) : (
              <Icon name="chevron-right" size={16} strokeWidth={2.5} />
            )}
          </button>
        )}
      </div>

      {attachError ? (
        <div data-testid="chat-attach-error" style={{ ...HINT, color: "var(--brand)" }}>
          {attachError}
        </div>
      ) : uploading ? (
        <div style={{ ...HINT, color: "var(--text-secondary)" }}>
          {i18n.t("chat.attach.uploading")}
        </div>
      ) : dragOver ? (
        <div style={{ ...HINT, color: "var(--brand)" }}>{i18n.t("chat.attach.dropHint")}</div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function hasFilesInDataTransfer(e: DragEvent<HTMLDivElement>): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes("Files");
}

/** Generate a readable filename for clipboard items (which come nameless). */
function clipboardFallbackName(mime: string): string {
  const ext = (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "");
  const ts = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `clipboard-${ts}.${ext}`;
}
