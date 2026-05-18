import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { api, type LlmCredential } from "../../../shared/api/client.js";
import type { ChatArtifact, ChatImageAttachment, ChatMessage, ChatSession } from "../types.js";
import { MessageBubble } from "./MessageBubble.js";
import { ChatInput } from "./ChatInput.js";

/**
 * Center column (flex: 1) — chat topbar, message stream, input bar.
 *
 * The stream auto-scrolls to the bottom whenever a new message is
 * appended or the streaming content grows. Empty state shows a friendly
 * hint inviting the user to say something.
 */

const CENTER: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  background: "var(--bg-page)",
  height: "100%",
};

const TOPBAR: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  padding: "12px 24px",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg-card)",
  flexShrink: 0,
};

const STREAM: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "24px 28px 8px",
};

export function MessageFlow({
  session,
  messages,
  streaming,
  onSend,
  onAbort,
  onArtifactSelect,
}: {
  session: ChatSession | null;
  messages: ChatMessage[];
  streaming: boolean;
  onSend: (text: string, images?: ChatImageAttachment[]) => void;
  onAbort: () => void;
  onArtifactSelect?: (artifact: ChatArtifact) => void;
}) {
  const streamRef = useRef<HTMLDivElement | null>(null);

  // Credentials are loaded once and resolved by id for the topbar chip.
  // Read-only in v1.0 — Phase 12 Step 2 will add a dropdown to switch
  // (requires bridge `models.json` + pi `set_model`).
  const [credentials, setCredentials] = useState<LlmCredential[]>([]);
  useEffect(() => {
    let mounted = true;
    api.settings
      .listCredentials()
      .then((res) => {
        if (mounted) setCredentials(res.credentials);
      })
      .catch(() => {
        /* silent — chip just won't render */
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Auto-scroll to bottom on message growth.
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    // Use rAF so we scroll after the DOM has laid out the new content.
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages.length, messages[messages.length - 1]?.content, streaming]);

  // Inject keyframes for the streaming caret blink animation.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById("vh-chat-keyframes")) return;
    const style = document.createElement("style");
    style.id = "vh-chat-keyframes";
    style.textContent =
      "@keyframes vh-caret-blink { 50% { opacity: 0; } }";
    document.head.appendChild(style);
  }, []);

  if (!session) {
    return (
      <section data-testid="chat-center" style={CENTER}>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-secondary)",
            fontSize: "13px",
            padding: "24px",
            textAlign: "center",
          }}
        >
          {i18n.t("chat.noSession")}
        </div>
      </section>
    );
  }

  return (
    <section data-testid="chat-center" style={CENTER}>
      {/* Topbar: session title + model chip + worker status indicator */}
      <header style={TOPBAR}>
        <h2
          data-testid="chat-session-title"
          style={{
            fontSize: "14px",
            fontWeight: 600,
            margin: 0,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--text-primary)",
          }}
        >
          {session.title}
        </h2>
        <ModelChip sessionId={session.id} credentials={credentials} credentialId={session.credential_id ?? null} />
        <WorkerBadge state={session.worker_state ?? "idle"} />
      </header>

      {/* Scrollable message stream */}
      <div data-testid="chat-message-stream" ref={streamRef} style={STREAM}>
        {messages.length === 0 ? (
          <div
            style={{
              padding: "80px 24px",
              textAlign: "center",
              color: "var(--text-secondary)",
              fontSize: "14px",
            }}
          >
            <Icon
              name="chat"
              size={40}
              style={{ opacity: 0.35, marginBottom: "16px" }}
            />
            <div style={{ maxWidth: "420px", margin: "0 auto", lineHeight: 1.6 }}>
              {i18n.t("chat.emptyMessages")}
            </div>
          </div>
        ) : (
          <>
            {messages
              .filter((m) => {
                // Hide empty assistant messages — they appear as orphan avatar
                // rows when the model returns no text (e.g. aborted call, tool
                // loop, server error). User messages are never filtered.
                if (m.role !== "assistant") return true;
                const text = (m.content ?? "").trim();
                return text.length > 0;
              })
              .map((m) => (
                <MessageBubble key={m.id} message={m} onArtifactSelect={onArtifactSelect} />
              ))}
            {streaming &&
            messages[messages.length - 1]?.role !== "assistant" ? (
              <div
                data-testid="chat-thinking-indicator"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "10px 14px",
                  background: "var(--bg-card)",
                  borderRadius: "8px",
                  color: "var(--text-secondary)",
                  fontSize: "13px",
                }}
              >
                <PulsingDots />
                <span>{i18n.t("chat.typing")}</span>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Input bar */}
      <ChatInput
        sessionId={session?.id ?? null}
        streaming={streaming}
        onSend={onSend}
        onAbort={onAbort}
      />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Bits                                                                      */
/* -------------------------------------------------------------------------- */

function ModelChip({
  sessionId,
  credentials,
  credentialId,
}: {
  sessionId: string;
  credentials: LlmCredential[];
  credentialId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [activeId, setActiveId] = useState(credentialId);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Keep activeId in sync when the session changes (e.g. switching sessions).
  useEffect(() => setActiveId(credentialId), [credentialId]);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const resolved =
    (activeId ? credentials.find((c) => c.id === activeId) : null) ??
    credentials.find((c) => c.is_default) ??
    credentials[0];
  if (!resolved) return null;

  const label = resolved.model_id || resolved.label || resolved.provider;
  const canSwitch = credentials.length > 1;

  async function handleSelect(cred: LlmCredential) {
    if (cred.id === resolved.id) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    try {
      await api.chat.sessions.setModel(sessionId, cred.id);
      setActiveId(cred.id);
    } catch {
      /* best-effort — chip still shows old model */
    }
    setSwitching(false);
    setOpen(false);
  }

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", display: "inline-flex" }}
    >
      <button
        type="button"
        data-testid="chat-model-chip"
        data-credential-id={resolved.id}
        title={
          canSwitch
            ? i18n.t("chat.model.switchHint")
            : i18n
                .t("chat.model.chipTooltip")
                .replace("{label}", resolved.label || resolved.model_id)
                .replace("{provider}", resolved.provider)
                .replace("{proto}", resolved.proto_type)
        }
        onClick={() => canSwitch && setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          padding: "3px 9px",
          borderRadius: "999px",
          fontSize: "11px",
          fontWeight: 500,
          lineHeight: 1.4,
          color: "var(--text-secondary)",
          background: open ? "var(--bg-hover)" : "var(--bg-page)",
          border: "1px solid var(--border)",
          maxWidth: "220px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          cursor: canSwitch ? "pointer" : "default",
          fontFamily: "inherit",
          transition: "background 0.12s",
        }}
      >
        <Icon name="cpu" size={11} strokeWidth={2} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {switching ? i18n.t("chat.model.switching") : label}
        </span>
        {canSwitch ? (
          <Icon
            name="chevron-down"
            size={10}
            style={{
              marginLeft: "2px",
              transform: open ? "rotate(180deg)" : undefined,
              transition: "transform 0.15s",
            }}
          />
        ) : null}
      </button>

      {open ? (
        <div
          data-testid="chat-model-dropdown"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: "220px",
            maxWidth: "320px",
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "8px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            zIndex: 50,
            padding: "4px 0",
            maxHeight: "240px",
            overflowY: "auto",
          }}
        >
          {credentials.map((c) => {
            const isActive = c.id === resolved.id;
            return (
              <button
                key={c.id}
                type="button"
                data-testid="chat-model-option"
                data-credential-id={c.id}
                onClick={() => void handleSelect(c)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  width: "100%",
                  padding: "8px 12px",
                  border: "none",
                  background: isActive ? "var(--bg-page)" : "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                  fontSize: "12px",
                  color: "var(--text-primary)",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (!isActive)
                    e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isActive
                    ? "var(--bg-page)"
                    : "transparent";
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.label || c.model_id}
                  </div>
                  <div
                    style={{
                      fontSize: "10.5px",
                      color: "var(--text-secondary)",
                      fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                      marginTop: "1px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.model_id}
                    {c.base_url ? " · " + c.base_url : ""}
                  </div>
                </div>
                {isActive ? (
                  <Icon
                    name="check"
                    size={14}
                    style={{ color: "var(--brand)", flexShrink: 0 }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function WorkerBadge({
  state,
}: {
  state: "idle" | "running" | "spawning";
}) {
  const cfg = {
    idle: {
      bg: "transparent",
      fg: "var(--text-secondary)",
      dot: "var(--text-secondary)",
      key: "chat.worker.idle",
    },
    running: {
      bg: "var(--bg-success)",
      fg: "var(--bg-success-text)",
      dot: "#16a34a",
      key: "chat.worker.running",
    },
    spawning: {
      bg: "var(--bg-warning)",
      fg: "#9a3412",
      dot: "#ea580c",
      key: "chat.worker.spawning",
    },
  }[state];
  return (
    <span
      data-testid="chat-worker-badge"
      data-state={state}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "3px 10px",
        borderRadius: "999px",
        fontSize: "11px",
        fontWeight: 500,
        background: cfg.bg,
        color: cfg.fg,
        border: state === "idle" ? "1px solid var(--border)" : "1px solid transparent",
        lineHeight: 1.4,
      }}
    >
      <span
        style={{
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          background: cfg.dot,
          animation: state === "spawning" ? "vh-caret-blink 1s infinite" : undefined,
        }}
      />
      {i18n.t(cfg.key)}
    </span>
  );
}

function PulsingDots() {
  return (
    <span
      style={{
        display: "inline-flex",
        gap: "3px",
      }}
    >
      {[0, 0.15, 0.3].map((d, i) => (
        <span
          key={i}
          style={{
            width: "5px",
            height: "5px",
            borderRadius: "50%",
            background: "var(--text-secondary)",
            animation: `vh-caret-blink 1s infinite`,
            animationDelay: `${d}s`,
          }}
        />
      ))}
    </span>
  );
}
