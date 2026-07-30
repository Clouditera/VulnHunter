/**
 * Finding detail tab body — v3 redesign (fish-approved prototype).
 * Eight-zone triage order + judgment strip popovers + dual-view fix_patch.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type FindingDetail as FindingDetailData,
  type FindingMeta,
  type WorkspaceFile,
} from "../../../shared/api/client";
import { i18n } from "../../../shared/i18n";
import { Icon } from "../../../shared/components/Icon";
import { Markdown } from "../../chat/components/Markdown";
import {
  resolvePocTabPill,
  resolveExpTabPill,
  type TabStatusPill,
} from "./FindingDynamicCards";

const SEV_COLORS: Record<string, string> = {
  critical: "var(--sev-high)",
  high: "var(--sev-high)",
  medium: "var(--sev-medium)",
  low: "var(--sev-low)",
  info: "var(--sev-info)",
};

const CARD: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  padding: "12px 14px",
  marginBottom: "12px",
};

const SEC_H: React.CSSProperties = {
  fontSize: "13px",
  fontWeight: 700,
  marginBottom: "8px",
  color: "var(--text-primary)",
};

export interface FindingAnchor {
  file_path?: string;
  line?: number;
  function?: string;
}

interface DataflowStep {
  step?: number | string;
  location?: string;
  description?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizePath(raw: string): string {
  return raw.replace(/^\/+workspace\/+/, "").replace(/^\/+/, "");
}

function strFromField(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function normalizeAnchors(value: unknown): FindingAnchor[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => asRecord(raw))
    .map((raw) => {
      const filePath = typeof raw.file_path === "string" ? raw.file_path : undefined;
      const line = typeof raw.line === "number" ? raw.line : Number(raw.line);
      const fn = typeof raw.function === "string" ? raw.function : undefined;
      return {
        file_path: filePath,
        line: Number.isFinite(line) ? line : undefined,
        function: fn,
      };
    })
    .filter((a) => !!a.file_path);
}

function normalizeDataflow(value: unknown): DataflowStep[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const o = asRecord(raw);
    return {
      step: (o.step as number | string | undefined) ?? undefined,
      location: typeof o.location === "string" ? o.location : undefined,
      description: typeof o.description === "string" ? o.description : undefined,
    };
  });
}

/**
 * Engine report text often hard-wraps at ~80 cols. Merge consecutive non-empty
 * lines into paragraphs (standard markdown soft-wrap); blank lines keep breaks.
 * Preserve fenced code blocks and list/table/heading markers.
 */
export function mergeHardWrappedMarkdown(src: string): string {
  if (!src) return src;
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let buf = "";
  let inFence = false;

  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = "";
    }
  };

  const isStructural = (line: string) =>
    /^(#{1,6}\s|```|~~~|\s*[-*+]\s|\s*\d+\.\s|\|)/.test(line) || line.startsWith(">");

  for (const line of lines) {
    if (/^```|^~~~/.test(line.trim())) {
      flush();
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      out.push("");
      continue;
    }
    if (isStructural(line)) {
      flush();
      out.push(line);
      continue;
    }
    if (!buf) buf = line.trimEnd();
    else buf += " " + line.trim();
  }
  flush();
  return out.join("\n");
}

function ReportMarkdown({ content }: { content: string }) {
  const merged = useMemo(() => mergeHardWrappedMarkdown(content), [content]);
  return (
    <div
      className="finding-md"
      style={{ fontSize: "12.5px", lineHeight: 1.7, color: "var(--text-secondary)" }}
    >
      <Markdown content={merged} />
    </div>
  );
}

function DescPart({ label, content, first }: { label: string; content?: string; first?: boolean }) {
  if (!content?.trim()) return null;
  return (
    <div
      data-testid="finding-desc-part"
      style={{ padding: first ? "0 0 12px" : "12px 0", borderTop: first ? "none" : "1px solid var(--divider)" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          fontSize: "11.5px",
          fontWeight: 700,
          color: "var(--text-primary)",
          letterSpacing: "0.8px",
          marginBottom: "7px",
        }}
      >
        <span
          aria-hidden
          style={{ width: "3px", height: "11px", background: "var(--brand)", borderRadius: "2px", flexShrink: 0 }}
        />
        {label}
      </div>
      <ReportMarkdown content={content} />
    </div>
  );
}

/* ---------- Diff: unified + side-by-side ---------- */

type DiffLine =
  | { kind: "hunk"; text: string }
  | { kind: "meta"; text: string }
  | { kind: "add"; text: string; right: number }
  | { kind: "del"; text: string; left: number }
  | { kind: "ctx"; text: string; left: number; right: number };

function parseUnifiedDiff(content: string): DiffLine[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const out: DiffLine[] = [];
  let left = 0;
  let right = 0;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = /@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)/.exec(line);
      if (m) {
        left = Number(m[1]) - 1;
        right = Number(m[2]) - 1;
      }
      out.push({ kind: "hunk", text: line });
      continue;
    }
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      out.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      right += 1;
      out.push({ kind: "add", text: line.slice(1), right });
      continue;
    }
    if (line.startsWith("-")) {
      left += 1;
      out.push({ kind: "del", text: line.slice(1), left });
      continue;
    }
    // context (leading space optional)
    const body = line.startsWith(" ") ? line.slice(1) : line;
    left += 1;
    right += 1;
    out.push({ kind: "ctx", text: body, left, right });
  }
  return out;
}

type SbsRow =
  | { kind: "hunk" | "meta"; text: string }
  | {
      kind: "pair";
      left?: { ln: number; text: string; del?: boolean };
      right?: { ln: number; text: string; add?: boolean };
    };

/**
 * Pair dels with following adds (standard unified→sbs).
 * Unequal counts get empty placeholder cells so rows stay 1:1 aligned.
 */
function toSideBySide(lines: DiffLine[]): SbsRow[] {
  const rows: SbsRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const L = lines[i]!;
    if (L.kind === "hunk" || L.kind === "meta") {
      rows.push({ kind: L.kind, text: L.text });
      i += 1;
      continue;
    }
    if (L.kind === "ctx") {
      rows.push({
        kind: "pair",
        left: { ln: L.left, text: L.text },
        right: { ln: L.right, text: L.text },
      });
      i += 1;
      continue;
    }
    // Only adds (no preceding dels in this run)
    if (L.kind === "add") {
      const adds: Extract<DiffLine, { kind: "add" }>[] = [];
      while (i < lines.length && lines[i]!.kind === "add") {
        adds.push(lines[i] as Extract<DiffLine, { kind: "add" }>);
        i += 1;
      }
      for (const a of adds) {
        rows.push({ kind: "pair", left: undefined, right: { ln: a.right, text: a.text, add: true } });
      }
      continue;
    }
    // dels then optional adds
    const dels: Extract<DiffLine, { kind: "del" }>[] = [];
    const adds: Extract<DiffLine, { kind: "add" }>[] = [];
    while (i < lines.length && lines[i]!.kind === "del") {
      dels.push(lines[i] as Extract<DiffLine, { kind: "del" }>);
      i += 1;
    }
    while (i < lines.length && lines[i]!.kind === "add") {
      adds.push(lines[i] as Extract<DiffLine, { kind: "add" }>);
      i += 1;
    }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const d = dels[k];
      const a = adds[k];
      rows.push({
        kind: "pair",
        left: d ? { ln: d.left, text: d.text, del: true } : undefined,
        right: a ? { ln: a.right, text: a.text, add: true } : undefined,
      });
    }
  }
  return rows;
}

const SBS_LINE_H = 20;
const SBS_GUTTER_W = 44;

function sbsTone(
  side: { del?: boolean; add?: boolean } | undefined,
): "del" | "add" | "ctx" | "empty" {
  if (!side) return "empty";
  if (side.del) return "del";
  if (side.add) return "add";
  return "ctx";
}

function sbsBg(tone: "del" | "add" | "ctx" | "empty"): string {
  if (tone === "del") return "var(--bg-error)";
  if (tone === "add") return "#f0fdf4";
  if (tone === "empty") return "rgba(0,0,0,0.02)";
  return "transparent";
}

function sbsColor(tone: "del" | "add" | "ctx" | "empty"): string {
  if (tone === "del") return "var(--danger-hover)";
  if (tone === "add") return "#15803d";
  return "var(--text-primary)";
}

/** One column of the side-by-side diff: gutter + single horizontal scroller for all lines. */
function SbsColumn({
  rows,
  side,
  testid,
}: {
  rows: SbsRow[];
  side: "left" | "right";
  testid: string;
}) {
  return (
    <div
      data-testid={testid}
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        flex: "1 1 50%",
        borderLeft: side === "right" ? "1px solid var(--border)" : undefined,
      }}
    >
      {/* Horizontal scroll wraps the whole column content (one bar at bottom). */}
      <div style={{ overflowX: "auto", overflowY: "hidden", flex: 1, minHeight: 0 }}>
        <div style={{ display: "inline-block", minWidth: "100%", verticalAlign: "top" }}>
          {rows.map((row, idx) => {
            if (row.kind !== "pair") {
              // Hunk/meta only drawn once on left; right shows spacer for row height sync
              if (side === "right") {
                return (
                  <div
                    key={idx}
                    style={{
                      height: SBS_LINE_H,
                      lineHeight: `${SBS_LINE_H}px`,
                      background: row.kind === "hunk" ? "#eff6ff" : "#fafafa",
                    }}
                  />
                );
              }
              return (
                <div
                  key={idx}
                  style={{
                    padding: "0 8px",
                    whiteSpace: "pre",
                    height: SBS_LINE_H,
                    lineHeight: `${SBS_LINE_H}px`,
                    color: row.kind === "hunk" ? "var(--brand)" : "var(--text-secondary)",
                    background: row.kind === "hunk" ? "#eff6ff" : "#fafafa",
                    fontWeight: 600,
                  }}
                >
                  {row.text || " "}
                </div>
              );
            }
            const cell = side === "left" ? row.left : row.right;
            const tone = sbsTone(cell);
            return (
              <div
                key={idx}
                style={{
                  display: "flex",
                  height: SBS_LINE_H,
                  lineHeight: `${SBS_LINE_H}px`,
                  background: sbsBg(tone),
                  color: sbsColor(tone),
                  boxSizing: "border-box",
                }}
              >
                <span
                  style={{
                    width: SBS_GUTTER_W,
                    flexShrink: 0,
                    color: "#9ca3af",
                    textAlign: "right",
                    paddingRight: 8,
                    userSelect: "none",
                    fontSize: 11,
                  }}
                >
                  {cell ? cell.ln : ""}
                </span>
                <span
                  style={{
                    whiteSpace: "pre",
                    paddingRight: 12,
                    display: "inline-block",
                  }}
                >
                  {cell ? cell.text || " " : " "}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FixPatchSection({ content }: { content: string }) {
  const [mode, setMode] = useState<"unified" | "sbs">("sbs"); // fish: 对比视图默认
  const parsed = useMemo(() => parseUnifiedDiff(content), [content]);
  const sbs = useMemo(() => toSideBySide(parsed), [parsed]);

  return (
    <div data-testid="finding-section-fix" style={CARD}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "8px" }}>
        <div style={{ ...SEC_H, marginBottom: 0 }}>{i18n.t("findings.section.fix")}</div>
        <div
          style={{
            display: "flex",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          {([
            ["unified", i18n.t("findings.diff.unified")],
            ["sbs", i18n.t("findings.diff.sbs")],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              data-testid={`finding-diff-mode-${id}`}
              onClick={() => setMode(id)}
              style={{
                border: "none",
                padding: "4px 10px",
                fontSize: "11px",
                fontWeight: mode === id ? 700 : 500,
                background: mode === id ? "var(--bg-error)" : "var(--bg-card)",
                color: mode === id ? "var(--brand)" : "var(--text-secondary)",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {mode === "unified" ? (
        <div
          data-testid="finding-diff-unified"
          style={{
            background: "#f8f8f8",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            overflow: "auto",
            maxHeight: "360px",
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            fontSize: "11.5px",
            lineHeight: 1.55,
          }}
        >
          {parsed.map((L, idx) => {
            const bg =
              L.kind === "add"
                ? "#f0fdf4"
                : L.kind === "del"
                  ? "var(--bg-error)"
                  : L.kind === "hunk"
                    ? "#eff6ff"
                    : "transparent";
            const color =
              L.kind === "add"
                ? "#15803d"
                : L.kind === "del"
                  ? "var(--danger-hover)"
                  : L.kind === "hunk"
                    ? "var(--brand)"
                    : L.kind === "meta"
                      ? "var(--text-secondary)"
                      : "var(--text-primary)";
            const prefix = L.kind === "add" ? "+" : L.kind === "del" ? "-" : L.kind === "ctx" ? " " : "";
            const text = L.kind === "add" || L.kind === "del" || L.kind === "ctx" ? prefix + L.text : L.text;
            return (
              <div key={idx} style={{ padding: "0 10px", whiteSpace: "pre", background: bg, color, fontWeight: L.kind === "hunk" || L.kind === "meta" ? 600 : 400 }}>
                {text || " "}
              </div>
            );
          })}
        </div>
      ) : (
        <div
          data-testid="finding-diff-sbs"
          style={{
            border: "1px solid var(--border)",
            borderRadius: "6px",
            overflow: "hidden",
            maxHeight: "420px",
            display: "flex",
            flexDirection: "column",
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            fontSize: "11.5px",
          }}
        >
          <div
            style={{
              display: "flex",
              background: "#fafafa",
              fontWeight: 700,
              fontSize: "10.5px",
              letterSpacing: "0.5px",
              color: "var(--text-secondary)",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <div style={{ flex: "1 1 50%", minWidth: 0, padding: "4px 8px" }}>{i18n.t("findings.diff.original")}</div>
            <div style={{ flex: "1 1 50%", minWidth: 0, padding: "4px 8px", borderLeft: "1px solid var(--border)" }}>
              {i18n.t("findings.diff.patched")}
            </div>
          </div>
          {/* Shared vertical scroll; each column has its own bottom horizontal bar */}
          <div
            style={{
              display: "flex",
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              overflowX: "hidden",
            }}
          >
            <SbsColumn rows={sbs} side="left" testid="finding-diff-sbs-left" />
            <SbsColumn rows={sbs} side="right" testid="finding-diff-sbs-right" />
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Anchor accordion with live snippet ---------- */

function AnchorSnippet({ taskId, path, line }: { taskId: string; path: string; line?: number }) {
  const { data, isLoading } = useQuery<WorkspaceFile>({
    queryKey: ["workspace-file-snippet", taskId, path, line ?? 0],
    queryFn: () => api.tasks.workspaceFile(taskId, path, line),
  });
  if (isLoading) {
    return <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "8px 12px" }}>{i18n.t("findings.detail.loading")}</div>;
  }
  if (!data || data.type !== "text" || !data.content) {
    return <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "8px 12px" }}>{i18n.t("findings.code.unavailable")}</div>;
  }
  const all = data.content.split("\n");
  const focus = line && line > 0 ? line : data.requested_line ?? 1;
  const start = Math.max(0, focus - 6);
  const end = Math.min(all.length, focus + 6);
  const slice = all.slice(start, end);
  return (
    <div
      data-testid="finding-anchor-snippet"
      style={{
        background: "#f8f8f8",
        border: "1px solid var(--border)",
        borderRadius: "6px",
        padding: "8px 0",
        overflow: "auto",
        fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        fontSize: "11.5px",
        lineHeight: 1.6,
        margin: "10px 12px 6px",
      }}
    >
      {slice.map((text, i) => {
        const ln = start + i + 1;
        const active = ln === focus;
        return (
          <div
            key={ln}
            style={{
              display: "flex",
              background: active ? "rgba(194,40,40,0.08)" : "transparent",
              borderLeft: active ? "3px solid var(--brand)" : "3px solid transparent",
              padding: "0 12px 0 8px",
              whiteSpace: "pre",
            }}
          >
            <span style={{ width: "36px", flexShrink: 0, color: "#9ca3af", textAlign: "right", paddingRight: "10px", userSelect: "none" }}>{ln}</span>
            <span style={{ minWidth: 0, flex: 1, color: "var(--text-primary)" }}>{text || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

function AffectedCodeSection({
  taskId,
  anchors,
  onOpenTree,
}: {
  taskId: string;
  anchors: FindingAnchor[];
  onOpenTree: (a: FindingAnchor) => void;
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(0); // expand first anchor by default
  if (anchors.length === 0) return null;
  return (
    <div data-testid="finding-section-affected-code" style={CARD}>
      <div style={SEC_H}>
        {i18n.t("findings.section.affectedCode")}{" "}
        <span style={{ fontWeight: 400, fontSize: "11px", color: "var(--text-secondary)" }}>
          {anchors.length}
        </span>
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: "8px", overflow: "hidden" }}>
        {anchors.map((a, idx) => {
          const open = openIdx === idx;
          const path = a.file_path ?? "";
          const label = `${path}${a.line ? `:${a.line}` : ""}${a.function ? ` · ${a.function}` : ""}`;
          return (
            <div key={`${path}:${a.line}:${idx}`} style={{ borderTop: idx === 0 ? "none" : "1px solid var(--divider)" }}>
              <button
                type="button"
                data-testid={`finding-anchor-row-${idx}`}
                onClick={() => setOpenIdx(open ? null : idx)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "9px 12px",
                  border: "none",
                  background: open ? "var(--bg-error)" : "var(--bg-card)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                }}
              >
                <Icon name="code" size={12} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontFamily: "ui-monospace, Menlo, monospace",
                    fontSize: "11.5px",
                    color: "var(--text-primary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </span>
                <span
                  aria-hidden
                  style={{
                    fontSize: "14px",
                    color: "var(--text-secondary)",
                    transform: open ? "rotate(90deg)" : "none",
                    transition: "transform 0.12s",
                  }}
                >
                  ›
                </span>
              </button>
              {open ? (
                <div>
                  <AnchorSnippet taskId={taskId} path={normalizePath(path)} line={a.line} />
                  <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 12px 10px" }}>
                    <button
                      type="button"
                      data-testid={`finding-anchor-open-tree-${idx}`}
                      onClick={() => onOpenTree(a)}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "var(--brand)",
                        fontSize: "11.5px",
                        fontWeight: 600,
                        cursor: "pointer",
                        fontFamily: "inherit",
                        padding: 0,
                      }}
                    >
                      {i18n.t("findings.code.openInTree")} →
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Judgment strip + info popovers ---------- */

function InfoPopover({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      data-testid="finding-info-popover"
      style={{
        position: "absolute",
        top: "calc(100% + 6px)",
        left: 0,
        zIndex: 20,
        width: "min(420px, 80vw)",
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
        padding: "10px 12px",
      }}
    >
      <div style={{ fontSize: "11.5px", fontWeight: 700, marginBottom: "6px", color: "var(--text-primary)" }}>{title}</div>
      <div style={{ fontSize: "11.5px", lineHeight: 1.65, color: "var(--text-secondary)", maxHeight: "300px", overflow: "auto" }}>
        {children}
      </div>
    </div>
  );
}

function Chip({
  children,
  tone = "default",
  testid,
}: {
  children: React.ReactNode;
  tone?: "default" | "ok" | "pill";
  testid?: string;
}) {
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "11px",
    fontWeight: 600,
    borderRadius: "6px",
    padding: "3px 8px",
    border: "1px solid var(--border)",
    background: "var(--bg-card)",
    color: "var(--text-secondary)",
    whiteSpace: "nowrap",
  };
  if (tone === "ok") {
    base.color = "var(--status-completed)";
    base.borderColor = "#bbf7d0";
    base.background = "#f0fdf4";
  }
  return (
    <span data-testid={testid} style={base}>
      {children}
    </span>
  );
}

function PillFromTab({ pill }: { pill: TabStatusPill }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: "11px",
        fontWeight: 600,
        borderRadius: "6px",
        padding: "3px 8px",
        background: pill.background,
        color: pill.color,
        border: pill.border,
        whiteSpace: "nowrap",
      }}
    >
      {pill.label}
    </span>
  );
}

/** Prefix status with stage name so chips read as complete phrases. */
function labeledStatus(stage: string, statusLabel: string, ok: boolean): string {
  return ok ? `${stage} ✓${statusLabel}` : `${stage} ${statusLabel}`;
}

function JudgmentStrip({
  finding,
  dynamicEnabled,
  isRisk: _isRisk,
}: {
  finding: FindingMeta;
  dynamicEnabled: boolean;
  isRisk: boolean;
}) {
  void _isRisk;
  const [pop, setPop] = useState<"cvss" | "ev" | null>(null);
  const pocPill = resolvePocTabPill(finding, dynamicEnabled);
  const expPill = resolveExpTabPill(finding, dynamicEnabled);

  // Judgment-strip labels: always include the stage name (fish v3.1).
  // Risk skip labels already embed the stage verb — use them as-is to avoid
  // "动态验证 不执行动态验证" duplication.
  const staticLabel = labeledStatus(
    i18n.t("finding.judgment.static"),
    i18n.t("finding.cards.static.confirmed"),
    true,
  );
  const pocIsRiskSkip = pocPill.label === i18n.t("finding.cards.poc.riskSkipLabel");
  const expIsRiskSkip = expPill.label === i18n.t("finding.cards.exp.riskSkipLabel");
  const pocLabel = pocIsRiskSkip
    ? pocPill.label
    : labeledStatus(
        i18n.t("finding.judgment.poc"),
        pocPill.label,
        /reproduced|已复现/i.test(pocPill.label),
      );
  const expLabel = expIsRiskSkip
    ? expPill.label
    : labeledStatus(
        i18n.t("finding.judgment.exp"),
        expPill.label,
        /confirmed|影响已确认/i.test(expPill.label),
      );

  const cvssParts = useMemo(() => {
    const v = finding.cvss_vector ?? "";
    // AV:L/AC:L/... → short zh gloss
    const map: Record<string, string> = {
      "AV:N": "攻击向量·网络",
      "AV:A": "攻击向量·邻接",
      "AV:L": "攻击向量·本地",
      "AV:P": "攻击向量·物理",
      "AC:L": "复杂度·低",
      "AC:H": "复杂度·高",
      "PR:N": "权限·无",
      "PR:L": "权限·低",
      "PR:H": "权限·高",
      "UI:N": "交互·无",
      "UI:R": "交互·需要",
      "S:U": "范围·不变",
      "S:C": "范围·改变",
      "C:N": "机密性·无",
      "C:L": "机密性·低",
      "C:H": "机密性·高",
      "I:N": "完整性·无",
      "I:L": "完整性·低",
      "I:H": "完整性·高",
      "A:N": "可用性·无",
      "A:L": "可用性·低",
      "A:H": "可用性·高",
    };
    return v
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ({ key: p, gloss: map[p] ?? p }));
  }, [finding.cvss_vector]);

  const rowStyle: React.CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    width: "100%",
  };

  return (
    <div
      data-testid="finding-judgment-strip"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: "8px",
        marginBottom: "12px",
        width: "100%",
      }}
    >
      {/* Row 1: three stage statuses with name labels (must be its own flex row). */}
      <div data-testid="finding-judgment-status-row" style={rowStyle}>
        <Chip tone="ok" testid="finding-chip-static">
          {staticLabel}
        </Chip>
        <span data-testid="finding-chip-poc">
          <PillFromTab pill={{ ...pocPill, label: pocLabel }} />
        </span>
        <span data-testid="finding-chip-exp">
          <PillFromTab pill={{ ...expPill, label: expLabel }} />
        </span>
      </div>

      {/* Row 2: scores only — separate block so it never sits on the status row. */}
      <div data-testid="finding-judgment-score-row" style={rowStyle}>
        {(finding.cvss_score != null || finding.cvss_vector) && (
          <span style={{ position: "relative", display: "inline-flex" }}>
            <Chip testid="finding-chip-cvss">
              <b style={{ fontWeight: 800, color: "var(--text-primary)" }}>CVSS {finding.cvss_score ?? "—"}</b>
              {finding.cvss_vector ? (
                <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: "10px", fontWeight: 500, color: "var(--text-secondary)" }}>
                  {finding.cvss_vector}
                </span>
              ) : null}
              <button
                type="button"
                aria-label="CVSS info"
                data-testid="finding-chip-cvss-info"
                onClick={() => setPop((p) => (p === "cvss" ? null : "cvss"))}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  padding: 0,
                  width: "16px",
                  height: "16px",
                  display: "inline-grid",
                  placeItems: "center",
                  fontSize: "12px",
                  lineHeight: 1,
                }}
              >
                ⓘ
              </button>
            </Chip>
            <InfoPopover open={pop === "cvss"} onClose={() => setPop(null)} title={i18n.t("findings.cvss.popoverTitle")}>
              {cvssParts.length === 0 ? (
                <div>—</div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: "18px" }}>
                  {cvssParts.map((p) => (
                    <li key={p.key} style={{ marginBottom: "3px" }}>
                      <code style={{ fontSize: "11px" }}>{p.key}</code> = {p.gloss}
                    </li>
                  ))}
                </ul>
              )}
            </InfoPopover>
          </span>
        )}

        {(finding.ev_score != null || finding.ev_priority || finding.ev_rationale) && (
          <span style={{ position: "relative", display: "inline-flex" }}>
            <Chip testid="finding-chip-ev">
              <b style={{ fontWeight: 800, color: "var(--text-primary)" }}>
                EV {finding.ev_score ?? "—"}
                {finding.ev_priority ? ` ${finding.ev_priority}` : ""}
              </b>
              {finding.ev_vector ? (
                <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: "10px", fontWeight: 500, color: "var(--text-secondary)" }}>
                  {finding.ev_vector}
                </span>
              ) : null}
              <button
                type="button"
                aria-label="EV info"
                data-testid="finding-chip-ev-info"
                onClick={() => setPop((p) => (p === "ev" ? null : "ev"))}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  padding: 0,
                  width: "16px",
                  height: "16px",
                  display: "inline-grid",
                  placeItems: "center",
                  fontSize: "12px",
                  lineHeight: 1,
                }}
              >
                ⓘ
              </button>
            </Chip>
            <InfoPopover open={pop === "ev"} onClose={() => setPop(null)} title={i18n.t("findings.ev.popoverTitle")}>
              <div style={{ whiteSpace: "pre-wrap" }}>{finding.ev_rationale?.trim() || "—"}</div>
            </InfoPopover>
          </span>
        )}
      </div>
    </div>
  );
}

export function FindingDetailV3({
  taskId,
  finding,
  detail,
  loading,
  error,
  dynamicEnabled,
  reviewSlot,
}: {
  taskId: string;
  finding: FindingMeta;
  detail: FindingDetailData | undefined;
  loading: boolean;
  error: Error | null;
  dynamicEnabled: boolean;
  /** Existing FindingReviewSection rendered by parent (keeps mutations/tests). */
  reviewSlot: React.ReactNode;
}) {
  const navigate = useNavigate();
  const sev = (finding.severity ?? "info").toLowerCase();
  const sevColor = SEV_COLORS[sev] ?? SEV_COLORS.info;
  const isRisk = finding.item_type === "risk" || finding.finding_class === "risk";

  if (loading) {
    return <div style={{ padding: "24px", color: "var(--text-secondary)", fontSize: "13px" }}>{i18n.t("findings.detail.loading")}</div>;
  }
  if (error) {
    return (
      <div style={{ padding: "24px", color: "var(--brand)", fontSize: "13px" }}>
        {i18n.t("findings.detail.error")}: {error.message}
      </div>
    );
  }
  if (!detail) {
    return <div style={{ padding: "24px", color: "var(--text-secondary)", fontSize: "13px" }}>{i18n.t("findings.detail.placeholder")}</div>;
  }

  const metadata = asRecord(detail.metadata);
  const description = asRecord(detail.description);
  const code = asRecord(detail.code);
  const refs = detail.references ?? [];
  const anchors = normalizeAnchors(metadata.anchors);
  const fallbackAnchor: FindingAnchor | null = finding.primary_file
    ? {
        file_path: finding.primary_file,
        line: finding.primary_line ?? undefined,
        function: finding.function_name ?? undefined,
      }
    : null;
  const allAnchors = anchors.length > 0 ? anchors : fallbackAnchor ? [fallbackAnchor] : [];
  const dataflow = normalizeDataflow(code.dataflow);
  const fixPatch =
    strFromField(code, "fix_patch") ??
    strFromField(code, "fix_code") ??
    undefined;
  const vulnType =
    strFromField(metadata, "vuln_type_full_name", "vuln_type") ??
    finding.vuln_type_full ??
    finding.vuln_type ??
    undefined;
  const cwe = strFromField(metadata, "cwe") ?? finding.cwe ?? undefined;

  const openTree = (a: FindingAnchor) => {
    const path = a.file_path;
    if (!path) return;
    const params = new URLSearchParams();
    params.set("file", normalizePath(path));
    if (a.line) params.set("line", String(a.line));
    navigate(`/tasks/${taskId}/workspace?${params.toString()}`);
  };

  return (
    <div data-testid="finding-detail-v3" style={{ padding: "14px 18px 20px", fontSize: "13px", width: "100%", boxSizing: "border-box" }}>
      {/* 1. Title row */}
      <div
        data-testid="finding-detail-header"
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "10px",
          paddingBottom: "10px",
          marginBottom: "10px",
          borderBottom: "1px solid var(--divider)",
        }}
      >
        <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: sevColor, flexShrink: 0, marginTop: "5px" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: "15px", lineHeight: 1.4, color: "var(--text-primary)", wordBreak: "break-word" }}>
            {finding.title ?? vulnType ?? finding.finding_key}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "6px", alignItems: "center" }}>
            <span
              data-testid={isRisk ? "finding-detail-risk-badge" : "finding-detail-vuln-badge"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "3px",
                padding: "1px 6px",
                borderRadius: "4px",
                border: isRisk ? "1px solid var(--border)" : "1px solid rgba(194,40,40,.35)",
                background: isRisk ? "var(--bg-page)" : "var(--bg-error)",
                color: isRisk ? "var(--text-secondary)" : "var(--brand)",
                fontSize: "9.5px",
                fontWeight: 700,
              }}
            >
              {isRisk ? <Icon name="shield" size={10} /> : null}
              {i18n.t(isRisk ? "finding.riskBadge" : "finding.vulnBadge")}
            </span>
            <span style={{ fontSize: "11px", fontWeight: 700, color: sevColor, textTransform: "uppercase", letterSpacing: "0.4px" }}>{sev}</span>
            {vulnType ? <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{vulnType}</span> : null}
            {cwe ? (
              <span style={{ fontSize: "11px", color: "var(--text-secondary)", fontFamily: "ui-monospace, Menlo, monospace" }}>{cwe}</span>
            ) : null}
            {finding.function_name ? (
              <span style={{ fontSize: "11px", color: "var(--text-secondary)", fontFamily: "ui-monospace, Menlo, monospace" }}>
                {finding.function_name}()
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* 2. Judgment strip */}
      <JudgmentStrip finding={finding} dynamicEnabled={dynamicEnabled} isRisk={isRisk} />

      {/* 3. Affected code */}
      <AffectedCodeSection taskId={taskId} anchors={allAnchors} onOpenTree={openTree} />

      {/* 4. Description — four engine fields */}
      <div data-testid="finding-section-description" style={CARD}>
        <div style={SEC_H}>{i18n.t("findings.section.description")}</div>
        <div style={{ borderTop: "none" }}>
          {(() => {
            const parts: Array<[string, string | undefined]> = [
              [i18n.t("findings.field.background"), strFromField(description, "background")],
              [i18n.t("findings.field.detail"), strFromField(description, "detailed_description")],
              [i18n.t("findings.field.payload"), strFromField(description, "attack_payload_description")],
              [i18n.t("findings.section.attack"), strFromField(description, "attack_description")],
              [i18n.t("findings.field.entryPoint"), strFromField(description, "entry_point")],
              [i18n.t("findings.field.taintSource"), strFromField(description, "taint_source")],
              [i18n.t("findings.field.trigger"), strFromField(description, "trigger_condition")],
            ];
            let seen = false;
            return parts.map(([label, content]) => {
              if (!content?.trim()) return null;
              const first = !seen;
              seen = true;
              return <DescPart key={label} first={first} label={label} content={content} />;
            });
          })()}
        </div>
      </div>

      {/* 5. Dataflow */}
      {dataflow.length > 0 ? (
        <div data-testid="finding-section-dataflow" style={CARD}>
          <div style={SEC_H}>{i18n.t("findings.section.dataFlow")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {dataflow.map((s, i) => (
              <div key={i} style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                <span
                  style={{
                    flexShrink: 0,
                    width: "22px",
                    height: "22px",
                    borderRadius: "50%",
                    background: "var(--bg-page)",
                    border: "1px solid var(--border)",
                    display: "grid",
                    placeItems: "center",
                    fontSize: "10px",
                    fontWeight: 700,
                    color: "var(--text-secondary)",
                  }}
                >
                  {s.step ?? i + 1}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  {s.location ? (
                    <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: "11.5px", color: "var(--text-primary)", marginBottom: "2px" }}>
                      {s.location}
                    </div>
                  ) : null}
                  {s.description ? (
                    <div style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.55 }}>{s.description}</div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* 6. Fix patch dual view */}
      {fixPatch ? <FixPatchSection content={fixPatch} /> : null}

      {/* 7. References */}
      {refs.length > 0 ? (
        <div data-testid="finding-section-references" style={CARD}>
          <div style={SEC_H}>{i18n.t("findings.section.references")}</div>
          <ul style={{ margin: 0, paddingLeft: "20px", fontSize: "12px" }}>
            {refs.map((ref, i) => {
              if (typeof ref === "string") {
                return (
                  <li key={i} style={{ marginBottom: "4px" }}>
                    {/^https?:\/\//.test(ref) ? (
                      <a href={ref} target="_blank" rel="noopener noreferrer" style={{ color: "var(--sev-low)", wordBreak: "break-all" }}>
                        {ref}
                      </a>
                    ) : (
                      <span style={{ color: "var(--text-primary)" }}>{ref}</span>
                    )}
                  </li>
                );
              }
              const entries = Object.entries(ref).filter(([, v]) => v != null);
              return (
                <li key={i} style={{ marginBottom: "4px" }}>
                  {entries.map(([k, v], j) => (
                    <span key={j}>
                      <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{k}</span>
                      {v != null && <span style={{ color: "var(--text-secondary)" }}>: {String(v)}</span>}
                      {j < entries.length - 1 && <span>, </span>}
                    </span>
                  ))}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* 8. Review at bottom */}
      <div data-testid="finding-section-review" style={{ ...CARD, marginBottom: 0 }}>
        {reviewSlot}
      </div>
    </div>
  );
}

