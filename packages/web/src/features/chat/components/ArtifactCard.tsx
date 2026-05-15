import type { CSSProperties } from "react";
import type { ChatArtifact } from "../types.js";

const CARD: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "8px",
  padding: "12px",
  background: "var(--bg-page)",
  marginTop: "10px",
};

const META: CSSProperties = {
  fontSize: "11px",
  color: "var(--text-secondary)",
  marginTop: "4px",
};

const PREVIEW: CSSProperties = {
  marginTop: "10px",
  padding: "10px",
  borderRadius: "6px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  maxHeight: "160px",
  overflow: "auto",
  whiteSpace: "pre-wrap",
  fontFamily: "'SF Mono', Menlo, Consolas, monospace",
  fontSize: "12px",
};

const BTN: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "6px",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  padding: "5px 9px",
  fontSize: "12px",
  cursor: "pointer",
};

export function ArtifactCard({ artifact, onSelect }: { artifact: ChatArtifact; onSelect?: (artifact: ChatArtifact) => void }) {
  const size = formatBytes(artifact.size_bytes);
  const canCopy = !!artifact.preview && /^(text\/|application\/(json|xml)|.*markdown)/i.test(artifact.mime_type);

  return (
    <div data-testid="chat-artifact-card" style={{ ...CARD, cursor: onSelect ? "pointer" : undefined }} onClick={() => onSelect?.(artifact)}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "10px" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: "13px", color: "var(--text-primary)" }}>{artifact.title}</div>
          <div style={META}>{artifact.filename} · {artifact.mime_type} · {size}</div>
        </div>
        <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
          {canCopy ? (
            <button type="button" style={BTN} onClick={() => navigator.clipboard?.writeText(artifact.preview ?? "")}>Copy</button>
          ) : null}
          <a style={{ ...BTN, textDecoration: "none" }} href={artifact.download_url} download={artifact.filename}>Download</a>
        </div>
      </div>
      {artifact.preview ? <pre style={PREVIEW}>{artifact.preview}</pre> : null}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
