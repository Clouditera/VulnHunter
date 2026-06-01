import type { CSSProperties } from "react";
import { Icon, type IconName } from "../../../shared/components/Icon.js";
import { i18n } from "../../../shared/i18n/index.js";
import type { ChatReferenceArtifact } from "../types.js";

const TYPE_STYLE: Record<
  ChatReferenceArtifact["type"],
  { icon: IconName; bg: string; color: string; fallback: string }
> = {
  task_ref: { icon: "tasks", bg: "rgba(37,99,235,0.08)", color: "#2563eb", fallback: "Task" },
  finding_ref: {
    icon: "alert-triangle",
    bg: "rgba(234,88,12,0.08)",
    color: "var(--sev-high)",
    fallback: "Finding",
  },
  wiki_ref: {
    icon: "book-open",
    bg: "rgba(115,115,115,0.08)",
    color: "var(--text-secondary)",
    fallback: "Wiki",
  },
  report_ref: {
    icon: "file-text",
    bg: "rgba(22,163,74,0.08)",
    color: "#16a34a",
    fallback: "Report",
  },
};

const CARD: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  padding: "10px 14px",
  borderRadius: "8px",
  border: "1px solid var(--border)",
  background: "var(--bg-page)",
  marginTop: "8px",
  cursor: "pointer",
  transition: "all 0.15s",
  width: "100%",
  fontFamily: "inherit",
  textAlign: "left",
};

export function ReferenceCard({
  artifact,
  onSelect,
}: { artifact: ChatReferenceArtifact; onSelect?: (artifact: ChatReferenceArtifact) => void }) {
  const cfg = TYPE_STYLE[artifact.type];
  return (
    <button
      type="button"
      data-testid="chat-ref-card"
      data-ref-type={artifact.type}
      onClick={() => onSelect?.(artifact)}
      style={CARD}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--brand)";
        e.currentTarget.style.boxShadow = "0 1px 4px rgba(0,0,0,0.06)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <span
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: cfg.bg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Icon name={cfg.icon} size={16} strokeWidth={1.75} style={{ color: cfg.color }} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {artifact.title || cfg.fallback}
        </span>
        {artifact.summary ? (
          <span
            style={{
              display: "block",
              fontSize: 12,
              color: "var(--text-secondary)",
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {artifact.summary}
          </span>
        ) : null}
      </span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 2,
          fontSize: 11,
          color: "var(--text-secondary)",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {i18n.t("chat.ref.viewInPanel")}
        <Icon name="chevron-right" size={12} />
      </span>
    </button>
  );
}

export function iconForReference(type: ChatReferenceArtifact["type"]): IconName {
  return TYPE_STYLE[type].icon;
}

export function colorForReference(type: ChatReferenceArtifact["type"]): string {
  return TYPE_STYLE[type].color;
}
