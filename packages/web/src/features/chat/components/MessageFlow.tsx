import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import type { ChatMessage, ChatSession } from "../types.js";
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
  onSend: (text: string) => void;
  onAbort: () => void;
}) {
  const streamRef = useRef<HTMLDivElement | null>(null);

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
      {/* Topbar: session title + worker status indicator */}
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
            {messages.map((m) => (
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
