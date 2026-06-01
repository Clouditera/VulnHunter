import { useState } from "react";
import type { CSSProperties } from "react";
import type { ChatArtifactUnion, ChatImageAttachment, ChatMessage } from "../types.js";
import { isFileArtifact } from "../types.js";
import { ToolCallBlock } from "./ToolCallBlock.js";
import { Markdown } from "./Markdown.js";
import { ArtifactCard } from "./ArtifactCard.js";
import { ReferenceCard } from "./ReferenceCard.js";
import { extractAllArtifacts, stripChatArtifactJson } from "../artifacts.js";

/**
 * A single message rendered inside the MessageFlow stream.
 *
 * User messages: right-aligned pill bubble (`.msg-user`).
 * Assistant messages: left-aligned with a 28px red "V" avatar and a
 *   body that supports inline markdown-ish formatting (bold, bullet
 *   lists, line breaks). Tool calls render as separate blocks before
 *   the final assistant text.
 *
 * We intentionally keep rendering lightweight — no full markdown
 * library — to avoid a bundle-size hit for v1. The formatter handles
 * the patterns pi rpc actually emits (paragraphs, `**bold**`, simple
 * `-` / `•` bullet lists, inline `code`).
 */

const USER_BUBBLE: CSSProperties = {
  maxWidth: "720px",
  background: "var(--bg-page)",
  padding: "10px 14px",
  borderRadius: "12px 12px 4px 12px",
  border: "1px solid var(--border)",
  fontSize: "14px",
  lineHeight: 1.6,
  color: "var(--text-primary)",
  width: "fit-content",
  whiteSpace: "pre-wrap",
  wordWrap: "break-word",
};

const IMG_GRID: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "6px",
  justifyContent: "flex-end",
  maxWidth: "720px",
};

const AGENT_ROW: CSSProperties = {
  display: "flex",
  gap: "12px",
  maxWidth: "820px",
};

const AVATAR: CSSProperties = {
  width: "28px",
  height: "28px",
  borderRadius: "50%",
  background: "var(--brand)",
  color: "#fff",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "13px",
  fontWeight: 700,
  flexShrink: 0,
  marginTop: "2px",
  letterSpacing: "-0.5px",
};

const AGENT_BODY: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: "14px",
  lineHeight: 1.7,
  color: "var(--text-primary)",
};

/** Subtle card wrapper so agent text lives inside a visible bubble, matching
 *  user messages' bubble style but with a distinct fill. */
const AGENT_BUBBLE: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "4px 12px 12px 12px",
  padding: "12px 16px",
  boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
  width: "fit-content",
  maxWidth: "100%",
};

export function MessageBubble({
  message,
  onArtifactSelect,
}: { message: ChatMessage; onArtifactSelect?: (artifact: ChatArtifactUnion) => void }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  if (message.role === "user") {
    const imgs = message.images ?? [];
    return (
      <div
        data-testid="chat-message"
        data-role="user"
        data-message-id={message.id}
        style={{ marginBottom: "20px", display: "flex", justifyContent: "flex-end" }}
      >
        <div
          style={{
            maxWidth: "720px",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "6px",
          }}
        >
          {imgs.length > 0 ? (
            <div data-testid="chat-message-images" style={IMG_GRID}>
              {imgs.map((img, i) => (
                <ImageThumb key={i} img={img} onOpen={() => setLightboxSrc(img.preview ?? null)} />
              ))}
            </div>
          ) : null}
          {message.content ? <div style={USER_BUBBLE}>{message.content}</div> : null}
        </div>
        {lightboxSrc ? <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} /> : null}
      </div>
    );
  }

  const artifacts = extractAllArtifacts([message]);
  const visibleContent = stripChatArtifactJson(message.content);

  return (
    <div
      data-testid="chat-message"
      data-role="assistant"
      data-message-id={message.id}
      data-streaming={message.streaming || undefined}
      style={{ marginBottom: "24px" }}
    >
      <div style={AGENT_ROW}>
        <span style={AVATAR}>V</span>
        <div style={AGENT_BODY}>
          {/* Tool calls render first, then the text. This matches pi rpc
              timing — tool calls happen before / during text generation. */}
          {isDebugToolsEnabled()
            ? (message.tool_calls ?? []).map((call, i) => <ToolCallBlock key={i} call={call} />)
            : null}
          <div
            data-testid="chat-message-content"
            style={visibleContent || artifacts.length ? AGENT_BUBBLE : undefined}
          >
            {visibleContent ? <Markdown content={visibleContent} /> : null}
            {artifacts.map((a) =>
              isFileArtifact(a) ? (
                <ArtifactCard key={a.artifact_id} artifact={a} onSelect={onArtifactSelect} />
              ) : (
                <ReferenceCard key={a.ref_id} artifact={a} onSelect={onArtifactSelect} />
              ),
            )}
            {message.streaming ? (
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: "8px",
                  height: "15px",
                  marginLeft: "3px",
                  background: "var(--text-primary)",
                  verticalAlign: "-2px",
                  animation: "va-caret-blink 1s steps(2) infinite",
                }}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Image thumbnail + lightbox                                                */
/* -------------------------------------------------------------------------- */

function ImageThumb({
  img,
  onOpen,
}: {
  img: ChatImageAttachment;
  onOpen: () => void;
}) {
  if (!img.preview) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={img.name ?? "image"}
      style={{
        width: "120px",
        height: "120px",
        padding: 0,
        border: "1px solid var(--border)",
        borderRadius: "8px",
        overflow: "hidden",
        cursor: "zoom-in",
        background: "var(--bg-page)",
        flexShrink: 0,
      }}
    >
      <img
        src={img.preview}
        alt={img.name ?? "image"}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
    </button>
  );
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  // Simple overlay. Click anywhere or Esc to close.
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.78)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "32px",
        cursor: "zoom-out",
      }}
    >
      <img
        src={src}
        alt=""
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          borderRadius: "8px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

function isDebugToolsEnabled(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem("va.chat.debugTools") === "1";
}
