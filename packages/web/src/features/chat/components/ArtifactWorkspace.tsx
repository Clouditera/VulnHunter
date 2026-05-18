import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "../../../shared/components/Icon.js";
import type { ChatArtifact, ChatMessage } from "../types.js";
import { extractChatArtifacts } from "../artifacts.js";
import { Markdown } from "./Markdown.js";

const ACTION: CSSProperties = { height: "28px", padding: "0 10px", borderRadius: "6px", fontSize: "12px", fontWeight: 500, cursor: "pointer" };

export function ArtifactWorkspace({ messages, persistedArtifacts = [], streaming, width, selectedArtifactId, onSelectedArtifactChange }: { messages: ChatMessage[]; persistedArtifacts?: ChatArtifact[]; streaming?: boolean; width?: number | string; selectedArtifactId?: string | null; onSelectedArtifactChange?: (id: string) => void }) {
  const artifacts = useMemo(() => mergeArtifacts(persistedArtifacts, extractChatArtifacts(messages)), [persistedArtifacts, messages]);
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  const selectedId = selectedArtifactId ?? internalSelectedId;
  const setSelectedId = (id: string) => {
    if (onSelectedArtifactChange) onSelectedArtifactChange(id);
    else setInternalSelectedId(id);
  };
  useEffect(() => {
    if (artifacts.length > 0) {
      const current = selectedArtifactId ?? internalSelectedId;
      if (!current || !artifacts.some((a) => a.artifact_id === current)) setSelectedId(artifacts[0].artifact_id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifacts, selectedArtifactId]);
  const selected = artifacts.find((a) => a.artifact_id === selectedId) ?? artifacts[0] ?? null;

  return (
    <aside data-testid="chat-artifact-panel" style={{ width: width ?? 440, minWidth: typeof width === "string" ? undefined : 360, maxWidth: typeof width === "string" ? undefined : 640, flexShrink: 0, background: "var(--bg-card)", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", height: "100%" }}>
      <header style={{ minHeight: 48, padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <Icon name="file-text" size={16} style={{ color: "var(--text-secondary)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>交付物预览区</div>
          {streaming ? <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>Agent 正在生成交付物…</div> : null}
        </div>
        {artifacts.length > 0 ? <span style={{ padding: "1px 8px", borderRadius: 10, background: "var(--divider)", color: "var(--text-secondary)", fontSize: 11, fontWeight: 600 }}>{artifacts.length}</span> : null}
      </header>
      {artifacts.length === 0 ? <EmptyArtifacts /> : <><ArtifactSwitcher artifacts={artifacts} selectedId={selected?.artifact_id ?? null} onSelect={setSelectedId} />{selected ? <ArtifactDetail artifact={selected} /> : null}</>}
    </aside>
  );
}

function ArtifactSwitcher({ artifacts, selectedId, onSelect }: { artifacts: ChatArtifact[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const vertical = artifacts.length > 4;
  return <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: vertical ? "column" : "row", gap: 6, overflowX: vertical ? "visible" : "auto", flexShrink: 0 }}>{artifacts.map((a) => {
    const active = a.artifact_id === selectedId;
    return <button key={a.artifact_id} role="tab" aria-selected={active} type="button" onClick={() => onSelect(a.artifact_id)} style={{ height: 32, padding: "0 10px", borderRadius: 8, border: `1px solid ${active ? "var(--brand)" : "var(--border)"}`, background: active ? "var(--bg-active-filter)" : "var(--bg-page)", display: "flex", alignItems: "center", gap: 6, cursor: "pointer", maxWidth: vertical ? "100%" : 150, flexShrink: 0 }}><Icon name={iconFor(a)} size={14} style={{ color: "var(--text-secondary)", flexShrink: 0 }} /><span style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-primary)" }}>{a.filename}</span></button>;
  })}</div>;
}

function ArtifactDetail({ artifact }: { artifact: ChatArtifact }) {
  const canCopy = canCopyArtifact(artifact);
  return <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}><div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}><div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}><div style={{ minWidth: 0 }}><div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{artifact.title || artifact.filename}</div><div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>{friendlyType(artifact)} · {formatBytes(artifact.size_bytes)}{artifact.created_at ? ` · ${formatTime(artifact.created_at)}` : ""}</div></div><div style={{ display: "flex", gap: 6, flexShrink: 0 }}><a aria-label={`下载 ${artifact.filename}`} href={artifact.download_url} download={artifact.filename} style={{ ...ACTION, display: "inline-flex", alignItems: "center", textDecoration: "none", border: "1px solid var(--brand)", background: "var(--brand)", color: "#fff" }}>下载</a>{canCopy ? <button aria-label={`复制 ${artifact.filename}`} type="button" style={{ ...ACTION, border: "1px solid var(--border)", background: "var(--bg-card)", color: "var(--text-primary)" }} onClick={() => navigator.clipboard?.writeText(artifact.preview ?? "")}>复制</button> : null}</div></div></div><div role="tabpanel" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 14 }}><ArtifactRenderer artifact={artifact} /></div></div>;
}

function ArtifactRenderer({ artifact }: { artifact: ChatArtifact }) {
  if (artifact.preview_status === "failed") return <DownloadMessage artifact={artifact} text="文件预览失败，请下载后查看。" testId="chat-artifact-preview-failed" />;
  if (artifact.preview_status === "unsupported" || !artifact.preview) return <DownloadMessage artifact={artifact} text="此文件暂不支持预览，请下载后查看。" testId="chat-artifact-binary-fallback" />;
  const preview = artifact.preview;
  const footer = artifact.preview_truncated ? <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-secondary)" }}>仅显示部分内容，下载可查看完整文件。</div> : null;
  if (isMarkdown(artifact)) return <><div data-testid="chat-artifact-markdown-preview" style={{ padding: 16, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 13, lineHeight: 1.65 }}><Markdown content={preview} /></div>{footer}</>;
  if (isHtml(artifact)) return <HtmlPreview html={preview} filename={artifact.filename} />;
  if (isJson(artifact)) return <><CodeBlock content={prettyJson(preview)} testId="chat-artifact-json-preview" />{footer}</>;
  if (isTextLike(artifact)) return <><CodeBlock content={preview} testId="chat-artifact-text-preview" />{footer}</>;
  return <DownloadMessage artifact={artifact} text="此文件暂不支持预览，请下载后查看。" testId="chat-artifact-binary-fallback" />;
}

function HtmlPreview({ html, filename }: { html: string; filename: string }) {
  const hadScript = /<script[\s\S]*?>[\s\S]*?<\/script>/i.test(html);
  const safe = html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");
  return <div data-testid="chat-artifact-html-preview">{hadScript ? <div style={{ marginBottom: 8, fontSize: 12, color: "var(--text-secondary)" }}>已以安全预览模式打开。</div> : null}<iframe title={`预览 ${filename}`} sandbox="" srcDoc={safe} style={{ width: "100%", minHeight: 520, background: "#fff", border: "1px solid var(--border)", borderRadius: 8 }} /></div>;
}

function CodeBlock({ content, testId }: { content: string; testId: string }) { return <pre data-testid={testId} style={{ margin: 0, padding: 12, borderRadius: 8, border: "1px solid var(--border)", background: "var(--code-bg, var(--bg-page))", color: "var(--code-text, var(--text-primary))", whiteSpace: "pre-wrap", fontFamily: "'SF Mono', Menlo, Consolas, monospace", fontSize: 12, lineHeight: 1.55 }}>{content}</pre>; }

function DownloadMessage({ artifact, text, testId }: { artifact: ChatArtifact; text: string; testId: string }) { return <div data-testid={testId} style={{ height: "100%", minHeight: 260, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", color: "var(--text-secondary)", gap: 12 }}><Icon name="archive" size={32} style={{ opacity: 0.55 }} /><div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{artifact.filename}</div><div style={{ fontSize: 12 }}>{text}</div><a href={artifact.download_url} download={artifact.filename} style={{ ...ACTION, display: "inline-flex", alignItems: "center", textDecoration: "none", border: "1px solid var(--brand)", background: "var(--brand)", color: "#fff" }}>下载文件</a></div>; }

function EmptyArtifacts() { return <div data-testid="chat-artifact-empty" style={{ flex: 1, padding: "48px 24px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", gap: 8, color: "var(--text-secondary)" }}><Icon name="file-text" size={28} style={{ opacity: 0.55 }} /><div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>在这里可以预览聊天中的附件</div><div style={{ fontSize: 12, lineHeight: 1.6 }}>当 Agent 生成报告、POC 或分析文件后，会显示在这里。</div></div>; }

function mergeArtifacts(...groups: ChatArtifact[][]): ChatArtifact[] { const out: ChatArtifact[] = []; const seen = new Set<string>(); for (const group of groups) for (const artifact of group) if (!seen.has(artifact.artifact_id)) { seen.add(artifact.artifact_id); out.push(artifact); } return out; }
function isMarkdown(a: ChatArtifact) { return /markdown/i.test(a.mime_type) || /\.(md|markdown)$/i.test(a.filename); }
function isHtml(a: ChatArtifact) { return /html/i.test(a.mime_type) || /\.html?$/i.test(a.filename); }
function isJson(a: ChatArtifact) { return /json/i.test(a.mime_type) || /\.json$/i.test(a.filename); }
function isTextLike(a: ChatArtifact) { return !!a.preview && (/^text\//i.test(a.mime_type) || /application\/(json|xml|javascript)/i.test(a.mime_type) || /markdown/i.test(a.mime_type)); }
function canCopyArtifact(a: ChatArtifact) { return !isHtml(a) && isTextLike(a) && a.preview_status !== "failed"; }
function iconFor(a: ChatArtifact): "file-text" | "code" | "archive" { return isJson(a) || isHtml(a) ? "code" : isTextLike(a) ? "file-text" : "archive"; }
function friendlyType(a: ChatArtifact) { return isMarkdown(a) ? "Markdown" : isHtml(a) ? "HTML" : isJson(a) ? "JSON" : isTextLike(a) ? "Text" : "Binary"; }
function prettyJson(raw: string) { try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; } }
function formatTime(s: string) { try { return new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } }
function formatBytes(n: number) { if (n < 1024) return `${n} B`; if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`; return `${(n / 1024 / 1024).toFixed(1)} MB`; }
