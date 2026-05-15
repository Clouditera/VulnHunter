import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import type { ArtifactRef, ChatMessage } from "../types.js";
import { extractChatArtifacts } from "../artifacts.js";
import { ArtifactCard } from "./ArtifactCard.js";

/**
 * Right column (360px) — "References" panel.
 *
 * v1.0 scope (per Architect): simple reference extraction from the
 * assistant's message stream. We regex for `BUG-\d+` and
 * `task:<uuid>`/`tasks/<uuid>` patterns and surface each unique match
 * as a card. Clicking a card highlights it (placeholder for v1.1 when
 * we'll open the finding detail inline or navigate to the task).
 *
 * When there are zero refs we show a muted empty hint. The panel has
 * no tabs in v1.0 — just a "References" heading.
 */

const PANEL: CSSProperties = {
  width: "360px",
  flexShrink: 0,
  background: "var(--bg-card)",
  borderLeft: "1px solid var(--border)",
  display: "flex",
  flexDirection: "column",
  height: "100%",
};

const HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  padding: "13px 16px",
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
};

const CONTENT: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "14px",
};

const CARD: CSSProperties = {
  padding: "12px 14px",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  marginBottom: "8px",
  background: "var(--bg-page)",
  cursor: "pointer",
  transition: "all 0.12s",
};

export function ArtifactPanel({ messages }: { messages: ChatMessage[] }) {
  const artifacts = useMemo(() => extractChatArtifacts(messages), [messages]);
  const refs = useMemo(() => extractRefs(messages), [messages]);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <aside data-testid="chat-artifact-panel" style={PANEL}>
      <header style={HEADER}>
        <Icon
          name="file-text"
          size={16}
          style={{ color: "var(--text-secondary)" }}
        />
        <span
          style={{
            fontSize: "13px",
            fontWeight: 600,
            flex: 1,
            color: "var(--text-primary)",
          }}
        >
          {i18n.t("chat.artifact.title")}
        </span>
        {artifacts.length + refs.length > 0 ? (
          <span
            style={{
              padding: "1px 8px",
              borderRadius: "10px",
              background: "var(--divider)",
              color: "var(--text-secondary)",
              fontSize: "11px",
              fontWeight: 600,
              lineHeight: 1.4,
            }}
          >
            {artifacts.length + refs.length}
          </span>
        ) : null}
      </header>

      <div style={CONTENT}>
        {artifacts.length === 0 && refs.length === 0 ? (
          <div
            data-testid="chat-artifact-empty"
            style={{
              padding: "40px 16px",
              textAlign: "center",
              fontSize: "12px",
              color: "var(--text-secondary)",
              lineHeight: 1.6,
            }}
          >
            {i18n.t("chat.artifact.empty")}
          </div>
        ) : (
          <>
          {artifacts.map((a) => <ArtifactCard key={a.artifact_id} artifact={a} />)}
          {refs.map((r) => (
            <div
              key={r.key}
              data-testid="chat-artifact-card"
              data-kind={r.kind}
              data-selected={selected === r.key || undefined}
              onClick={() => setSelected((s) => (s === r.key ? null : r.key))}
              style={{
                ...CARD,
                borderColor: selected === r.key ? "var(--brand)" : "var(--border)",
                background:
                  selected === r.key ? "var(--bg-active-filter)" : "var(--bg-page)",
              }}
              onMouseEnter={(e) => {
                if (selected !== r.key)
                  e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                if (selected !== r.key)
                  e.currentTarget.style.background = "var(--bg-page)";
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  marginBottom: "6px",
                }}
              >
                <span
                  style={{
                    fontSize: "10px",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: r.kind === "finding" ? "var(--brand)" : "var(--text-secondary)",
                  }}
                >
                  {r.kind === "finding"
                    ? i18n.t("chat.artifact.finding")
                    : i18n.t("chat.artifact.task")}
                </span>
                <span
                  style={{
                    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                    fontSize: "12px",
                    fontWeight: 600,
                    color: "var(--text-primary)",
                  }}
                >
                  {r.display}
                </span>
              </div>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--text-secondary)",
                  lineHeight: 1.5,
                }}
              >
                {/* v1.0: no detail fetch yet — just remind where it came from.
                    v1.1 will pull finding YAML via /api/tasks/:id/findings. */}
                Referenced in message #{r.source_message_id.slice(0, 4)}
              </div>
            </div>
          ))}
          </>
        )}
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/*  Reference extraction                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Scan every assistant message for references to findings or tasks.
 * Patterns matched:
 *   BUG-001, BUG-123, bug-42       → kind='finding'
 *   task:<uuid>, tasks/<uuid>      → kind='task'
 *
 * Deduped by normalised key so repeated mentions collapse into a
 * single card. Preserves discovery order so older refs stay on top.
 */
function extractRefs(messages: ChatMessage[]): ArtifactRef[] {
  const out: ArtifactRef[] = [];
  const seen = new Set<string>();
  const bugRe = /\bbug-\d+\b/gi;
  const taskRe = /\b(?:task[s]?[:/])([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/gi;

  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const text = m.content;
    let hit: RegExpExecArray | null;
    bugRe.lastIndex = 0;
    while ((hit = bugRe.exec(text)) !== null) {
      const display = hit[0].toUpperCase();
      const key = `bug:${display}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        kind: "finding",
        display,
        source_message_id: m.id,
      });
    }
    taskRe.lastIndex = 0;
    while ((hit = taskRe.exec(text)) !== null) {
      const uuid = hit[1];
      const key = `task:${uuid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        kind: "task",
        display: uuid.slice(0, 8),
        source_message_id: m.id,
      });
    }
  }
  return out;
}
