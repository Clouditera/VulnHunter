import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "../../../shared/components/Icon.js";
import type { ArtifactRef, ChatArtifact, ChatMessage } from "../types.js";
import { extractChatArtifacts } from "../artifacts.js";
import { Markdown } from "./Markdown.js";

const PANEL: CSSProperties = {
  width: "440px",
  minWidth: "360px",
  maxWidth: "640px",
  flexShrink: 0,
  background: "var(--bg-card)",
  borderLeft: "1px solid var(--border)",
  display: "flex",
  flexDirection: "column",
  height: "100%",
};

const HEADER: CSSProperties = {
  minHeight: "48px",
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  gap: "10px",
  flexShrink: 0,
};

const TABS: CSSProperties = {
  height: "32px",
  display: "flex",
  gap: "18px",
  padding: "0 16px",
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
};

const TAB_BTN: CSSProperties = {
  border: 0,
  background: "transparent",
  padding: 0,
  fontSize: "12px",
  cursor: "pointer",
};

const CONTENT: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "14px",
};

const ACTION: CSSProperties = {
  height: "28px",
  padding: "0 10px",
  borderRadius: "6px",
  fontSize: "12px",
  fontWeight: 500,
  cursor: "pointer",
};

export function ArtifactWorkspace({
  messages,
  persistedArtifacts = [],
  streaming,
}: {
  messages: ChatMessage[];
  persistedArtifacts?: ChatArtifact[];
  streaming?: boolean;
}) {
  const artifacts = useMemo(() => mergeArtifacts(persistedArtifacts, extractChatArtifacts(messages)), [persistedArtifacts, messages]);
  const refs = useMemo(() => extractRefs(messages), [messages]);
  const [tab, setTab] = useState<"artifacts" | "refs">("artifacts");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (artifacts.length > 0) {
      setTab("artifacts");
      setSelectedId((id) => id && artifacts.some((a) => a.artifact_id === id) ? id : artifacts[0].artifact_id);
    } else if (refs.length > 0) {
      setTab("refs");
    }
  }, [artifacts, refs.length]);

  const selected = artifacts.find((a) => a.artifact_id === selectedId) ?? artifacts[0] ?? null;

  return (
    <aside data-testid="chat-artifact-panel" style={PANEL}>
      <header style={HEADER}>
        <Icon name="file-text" size={16} style={{ color: "var(--text-secondary)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>交付物</div>
          {streaming ? <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }}>Agent 正在生成交付物…</div> : null}
        </div>
        {artifacts.length > 0 ? <CountBadge count={artifacts.length} /> : null}
      </header>

      <div style={TABS} role="tablist" aria-label="Chat artifact workspace tabs">
        <Tab active={tab === "artifacts"} onClick={() => setTab("artifacts")}>交付物</Tab>
        <Tab active={tab === "refs"} onClick={() => setTab("refs")}>引用</Tab>
      </div>

      {tab === "artifacts" ? (
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
          {artifacts.length === 0 ? <EmptyArtifacts /> : (
            <>
              <ArtifactSwitcher artifacts={artifacts} selectedId={selected?.artifact_id ?? null} onSelect={setSelectedId} />
              {selected ? <ArtifactDetail artifact={selected} /> : null}
            </>
          )}
        </div>
      ) : (
        <ReferenceList refs={refs} />
      )}
    </aside>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      type="button"
      onClick={onClick}
      style={{
        ...TAB_BTN,
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        borderBottom: active ? "2px solid var(--brand)" : "2px solid transparent",
        fontWeight: active ? 600 : 500,
      }}
    >
      {children}
    </button>
  );
}

function CountBadge({ count }: { count: number }) {
  return <span style={{ padding: "1px 8px", borderRadius: "10px", background: "var(--divider)", color: "var(--text-secondary)", fontSize: "11px", fontWeight: 600 }}>{count}</span>;
}

function ArtifactSwitcher({ artifacts, selectedId, onSelect }: { artifacts: ChatArtifact[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const vertical = artifacts.length > 4;
  return (
    <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: vertical ? "column" : "row", gap: "6px", overflowX: vertical ? "visible" : "auto", flexShrink: 0 }}>
      {artifacts.map((a) => {
        const active = a.artifact_id === selectedId;
        return (
          <button
            key={a.artifact_id}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onSelect(a.artifact_id)}
            style={{
              height: "32px",
              padding: "0 10px",
              borderRadius: "8px",
              border: `1px solid ${active ? "var(--brand)" : "var(--border)"}`,
              background: active ? "var(--bg-active-filter)" : "var(--bg-page)",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              cursor: "pointer",
              maxWidth: vertical ? "100%" : "150px",
              flexShrink: 0,
            }}
          >
            <Icon name={iconFor(a)} size={14} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
            <span style={{ fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-primary)" }}>{a.filename}</span>
          </button>
        );
      })}
    </div>
  );
}

function ArtifactDetail({ artifact }: { artifact: ChatArtifact }) {
  const canCopy = isTextLike(artifact);
  const meta = `${friendlyType(artifact)} · ${formatBytes(artifact.size_bytes)}${artifact.created_at ? ` · ${formatTime(artifact.created_at)}` : ""}`;
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{artifact.title || artifact.filename}</div>
            <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" }}>{meta}</div>
          </div>
          <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
            {canCopy ? <button aria-label={`复制 ${artifact.filename}`} type="button" style={{ ...ACTION, border: "1px solid var(--border)", background: "var(--bg-card)", color: "var(--text-primary)" }} onClick={() => navigator.clipboard?.writeText(artifact.preview ?? "")}>复制</button> : null}
            <a aria-label={`下载 ${artifact.filename}`} href={artifact.download_url} download={artifact.filename} style={{ ...ACTION, display: "inline-flex", alignItems: "center", textDecoration: "none", border: "1px solid var(--brand)", background: "var(--brand)", color: "#fff" }}>下载</a>
          </div>
        </div>
      </div>
      <div role="tabpanel" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "14px" }}>
        <ArtifactRenderer artifact={artifact} />
      </div>
    </div>
  );
}

function ArtifactRenderer({ artifact }: { artifact: ChatArtifact }) {
  const preview = artifact.preview ?? "";
  if (isMarkdown(artifact)) return <div data-testid="chat-artifact-markdown-preview" style={{ padding: "16px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "8px", fontSize: "13px", lineHeight: 1.65 }}><Markdown content={preview} /></div>;
  if (isHtml(artifact)) return <HtmlPreview html={preview} filename={artifact.filename} />;
  if (isJson(artifact)) return <CodeBlock content={prettyJson(preview)} testId="chat-artifact-json-preview" />;
  if (isTextLike(artifact)) return <CodeBlock content={preview} testId="chat-artifact-text-preview" />;
  return <BinaryFallback artifact={artifact} />;
}

function HtmlPreview({ html, filename }: { html: string; filename: string }) {
  const hadScript = /<script[\s\S]*?>[\s\S]*?<\/script>/i.test(html);
  const safe = html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");
  return (
    <div data-testid="chat-artifact-html-preview">
      {hadScript ? <div style={{ marginBottom: "8px", padding: "8px 10px", borderRadius: "6px", background: "var(--warning-bg, #fff7ed)", color: "var(--warning-text, #9a3412)", fontSize: "12px" }}>已安全禁用脚本，仅渲染静态 HTML。</div> : null}
      <iframe title={`预览 ${filename}`} sandbox="" srcDoc={safe} style={{ width: "100%", minHeight: "520px", background: "#fff", border: "1px solid var(--border)", borderRadius: "8px" }} />
    </div>
  );
}

function CodeBlock({ content, testId }: { content: string; testId: string }) {
  return <pre data-testid={testId} style={{ margin: 0, padding: "12px", borderRadius: "8px", border: "1px solid var(--border)", background: "var(--bg-page)", color: "var(--text-primary)", whiteSpace: "pre-wrap", fontFamily: "'SF Mono', Menlo, Consolas, monospace", fontSize: "12px", lineHeight: 1.55 }}>{content}</pre>;
}

function BinaryFallback({ artifact }: { artifact: ChatArtifact }) {
  return (
    <div data-testid="chat-artifact-binary-fallback" style={{ height: "100%", minHeight: "260px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", color: "var(--text-secondary)", gap: "12px" }}>
      <Icon name="archive" size={32} style={{ opacity: 0.55 }} />
      <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>{artifact.filename}</div>
      <div style={{ fontSize: "12px" }}>此文件暂不支持预览，可下载后查看。</div>
      <a href={artifact.download_url} download={artifact.filename} style={{ ...ACTION, display: "inline-flex", alignItems: "center", textDecoration: "none", border: "1px solid var(--brand)", background: "var(--brand)", color: "#fff" }}>下载文件</a>
    </div>
  );
}

function EmptyArtifacts() {
  return (
    <div data-testid="chat-artifact-empty" style={{ flex: 1, padding: "48px 24px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", gap: "8px", color: "var(--text-secondary)" }}>
      <Icon name="file-text" size={28} style={{ opacity: 0.55 }} />
      <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>暂无交付物</div>
      <div style={{ fontSize: "12px", lineHeight: 1.6 }}>Agent 生成报告、POC、日志或数据文件后，会显示在这里。</div>
    </div>
  );
}

function ReferenceList({ refs }: { refs: ArtifactRef[] }) {
  if (refs.length === 0) return <div style={CONTENT}><div style={{ padding: "40px 16px", textAlign: "center", fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.6 }}>暂无引用</div></div>;
  return (
    <div style={CONTENT}>
      {refs.map((r) => <div key={r.key} data-testid="chat-reference-card" style={{ padding: "12px 14px", border: "1px solid var(--border)", borderRadius: "8px", marginBottom: "8px", background: "var(--bg-page)" }}><div style={{ fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: r.kind === "finding" ? "var(--brand)" : "var(--text-secondary)" }}>{r.kind === "finding" ? "Finding" : "Task"}</div><div style={{ marginTop: "6px", fontFamily: "'SF Mono', Menlo, Consolas, monospace", fontSize: "12px", fontWeight: 600, color: "var(--text-primary)" }}>{r.display}</div><div style={{ marginTop: "6px", fontSize: "11px", color: "var(--text-secondary)" }}>Referenced in message #{r.source_message_id.slice(0, 4)}</div></div>)}
    </div>
  );
}

function mergeArtifacts(...groups: ChatArtifact[][]): ChatArtifact[] {
  const out: ChatArtifact[] = [];
  const seen = new Set<string>();
  for (const group of groups) for (const artifact of group) if (!seen.has(artifact.artifact_id)) { seen.add(artifact.artifact_id); out.push(artifact); }
  return out;
}

function extractRefs(messages: ChatMessage[]): ArtifactRef[] {
  const out: ArtifactRef[] = [];
  const seen = new Set<string>();
  const bugRe = /\bbug-\d+\b/gi;
  const taskRe = /\b(?:task[s]?[:/])([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/gi;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    let hit: RegExpExecArray | null;
    bugRe.lastIndex = 0;
    while ((hit = bugRe.exec(m.content)) !== null) {
      const display = hit[0].toUpperCase();
      const key = `bug:${display}`;
      if (!seen.has(key)) { seen.add(key); out.push({ key, kind: "finding", display, source_message_id: m.id }); }
    }
    taskRe.lastIndex = 0;
    while ((hit = taskRe.exec(m.content)) !== null) {
      const uuid = hit[1];
      const key = `task:${uuid}`;
      if (!seen.has(key)) { seen.add(key); out.push({ key, kind: "task", display: uuid.slice(0, 8), source_message_id: m.id }); }
    }
  }
  return out;
}

function isMarkdown(a: ChatArtifact) { return /markdown/i.test(a.mime_type) || /\.(md|markdown)$/i.test(a.filename); }
function isHtml(a: ChatArtifact) { return /html/i.test(a.mime_type) || /\.html?$/i.test(a.filename); }
function isJson(a: ChatArtifact) { return /json/i.test(a.mime_type) || /\.json$/i.test(a.filename); }
function isTextLike(a: ChatArtifact) { return !!a.preview && (/^text\//i.test(a.mime_type) || /application\/(json|xml|javascript)/i.test(a.mime_type) || /markdown|html/i.test(a.mime_type)); }
function iconFor(a: ChatArtifact): "file-text" | "code" | "archive" { return isJson(a) || isHtml(a) ? "code" : isTextLike(a) ? "file-text" : "archive"; }
function friendlyType(a: ChatArtifact) { return isMarkdown(a) ? "Markdown" : isHtml(a) ? "HTML" : isJson(a) ? "JSON" : isTextLike(a) ? "Text" : "Binary"; }
function prettyJson(raw: string) { try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; } }
function formatTime(s: string) { try { return new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } }
function formatBytes(n: number) { if (n < 1024) return `${n} B`; if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`; return `${(n / 1024 / 1024).toFixed(1)} MB`; }
