import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { api, type LlmCredential } from "../../../shared/api/client.js";
import type { ChatImageAttachment, ChatMessage, ChatSession } from "../types.js";
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
}: {
  session: ChatSession | null;
  messages: ChatMessage[];
  streaming: boolean;
  onSend: (text: string, images?: ChatImageAttachment[]) => void;
  onAbort: () => void;
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
        <ModelChip credentials={credentials} credentialId={session.credential_id ?? null} />
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
                <MessageBubble key={m.id} message={m} />
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
  credentials,
  credentialId,
}: {
  credentials: LlmCredential[];
  credentialId: string | null;
}) {
  // Resolve the session's credential — falls back to the default when
  // the session has no explicit binding (matches backend behaviour at
  // worker spawn time).
  const resolved =
    (credentialId ? credentials.find((c) => c.id === credentialId) : null) ??
    credentials.find((c) => c.is_default) ??
    credentials[0];
  if (!resolved) return null;

  // Show the short model_id (e.g. "mimo-v2-pro") — it's the most
  // scannable identifier. Provider goes into the tooltip so power users
  // can still see it.
  const label = resolved.model_id || resolved.label || resolved.provider;
  const tooltip = i18n
    .t("chat.model.chipTooltip")
    .replace("{label}", resolved.label || resolved.model_id)
    .replace("{provider}", resolved.provider)
    .replace("{proto}", resolved.proto_type);

  return (
    <span
      data-testid="chat-model-chip"
      data-credential-id={resolved.id}
      title={tooltip}
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
        background: "var(--bg-page)",
        border: "1px solid var(--border)",
        maxWidth: "220px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        cursor: "help",
      }}
    >
      <Icon name="cpu" size={11} strokeWidth={2} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
      </span>
    </span>
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
