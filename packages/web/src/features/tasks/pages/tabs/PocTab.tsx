import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import {
  api,
  type Task,
  type PocFile,
} from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";
import { Icon, type IconName } from "../../../../shared/components/Icon.js";

/* -------------------------------------------------------------------------- */
/*  Filename metadata                                                         */
/* -------------------------------------------------------------------------- */

interface ParsedName {
  bugId: string | null;
  title: string;
  language: string;
  extension: string;
}

/**
 * Parse a POC filename into displayable pieces.
 *
 * Examples:
 *   "BUG-001-heap-overread.py"  → bug="BUG-001", title="heap overread", lang="Python"
 *   "poc_integer_overflow.py"   → bug=null,     title="poc integer overflow", lang="Python"
 *   "exp_palette_crash.c"       → bug=null,     title="exp palette crash", lang="C"
 */
function parseName(name: string): ParsedName {
  const dotIdx = name.lastIndexOf(".");
  const ext = dotIdx > 0 ? name.slice(dotIdx + 1).toLowerCase() : "";
  const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;

  const bugMatch = base.match(/^(BUG-\d+)[-_ ]?/i);
  const bugId = bugMatch ? bugMatch[1].toUpperCase() : null;
  const remainder = bugId ? base.slice(bugMatch![0].length) : base;
  const title = remainder.replace(/[-_]+/g, " ").trim() || base;

  return { bugId, title, language: languageLabel(ext), extension: ext };
}

const LANG_LABELS: Record<string, string> = {
  py: "Python",
  c: "C",
  h: "C",
  cpp: "C++",
  cc: "C++",
  js: "JavaScript",
  ts: "TypeScript",
  sh: "Shell",
  bash: "Shell",
  rb: "Ruby",
  go: "Go",
  rs: "Rust",
  java: "Java",
  php: "PHP",
  yaml: "YAML",
  yml: "YAML",
  json: "JSON",
  md: "Markdown",
  txt: "Text",
};
function languageLabel(ext: string): string {
  return LANG_LABELS[ext] ?? (ext ? ext.toUpperCase() : "Plaintext");
}

function iconForFile(ext: string): IconName {
  // Default to code for most executables; file-text for data/docs.
  if (["md", "txt", "yaml", "yml", "json"].includes(ext)) return "file-text";
  return "code";
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return (n / 1_048_576).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return `${n} ${i18n.t("poc.bytes")}`;
}

/* -------------------------------------------------------------------------- */
/*  Shared styles                                                             */
/* -------------------------------------------------------------------------- */

const CARD: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "12px",
  overflow: "hidden",
};

const CARD_HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "12px",
  padding: "14px 18px",
  cursor: "pointer",
  transition: "background 0.12s",
  userSelect: "none",
};

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function PocTab() {
  const { task } = useOutletContext<{ task: Task }>();
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);

  const { data, isLoading, error } = useQuery({
    queryKey: ["poc-files", task.id],
    queryFn: () => api.tasks.poc(task.id),
    staleTime: 60_000,
  });

  const files = (data?.poc_files ?? []) as PocFile[];

  return (
    <div
      data-testid="task-detail-panel-poc"
      style={{ display: "flex", flexDirection: "column", gap: "12px" }}
    >
      {isLoading ? (
        <EmptyState text={i18n.t("poc.loading")} muted />
      ) : error ? (
        <EmptyState text={i18n.t("poc.errorFile")} variant="error" />
      ) : files.length === 0 ? (
        <EmptyState text={i18n.t("poc.empty")} muted />
      ) : (
        files.map((f) => <PocCard key={f.key} taskId={task.id} file={f} />)
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Card                                                                      */
/* -------------------------------------------------------------------------- */

function PocCard({ taskId, file }: { taskId: string; file: PocFile }) {
  const [expanded, setExpanded] = useState(false);
  const parsed = useMemo(() => parseName(file.name), [file.name]);

  const { data: fileData, isLoading, error } = useQuery({
    queryKey: ["poc-file", taskId, file.key],
    queryFn: () => api.tasks.pocContent(taskId, file.name, file.key),
    enabled: expanded,
    staleTime: 5 * 60_000,
  });

  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    if (!fileData?.content) return;
    try {
      await navigator.clipboard.writeText(fileData.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API may be blocked — no-op, button stays "Copy"
    }
  }

  function handleDownload() {
    if (!fileData?.content) return;
    const blob = new Blob([fileData.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <section
      data-testid="poc-card"
      data-bug-id={parsed.bugId || undefined}
      data-expanded={expanded || undefined}
      style={CARD}
    >
      {/* Header (click to toggle) */}
      <div
        data-testid="poc-card-header"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        style={CARD_HEADER}
      >
        {/* File-type icon tile */}
        <div
          aria-hidden
          style={{
            width: "36px",
            height: "36px",
            flexShrink: 0,
            borderRadius: "8px",
            background: "var(--bg-page)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-secondary)",
          }}
        >
          <Icon name={iconForFile(parsed.extension)} size={18} />
        </div>

        {/* Filename + meta */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            data-testid="poc-card-name"
            style={{
              fontSize: "14px",
              fontWeight: 600,
              fontFamily: "'SF Mono', Menlo, Consolas, monospace",
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {file.name}
          </div>
          <div
            style={{
              fontSize: "12px",
              color: "var(--text-secondary)",
              opacity: 0.85,
              marginTop: "2px",
              display: "flex",
              gap: "6px",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            {parsed.bugId ? (
              <span
                style={{
                  padding: "1px 6px",
                  borderRadius: "3px",
                  fontSize: "10px",
                  fontWeight: 700,
                  fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                  background: "rgba(220,38,38,0.12)",
                  color: "var(--brand)",
                  lineHeight: 1.4,
                }}
              >
                {parsed.bugId}
              </span>
            ) : null}
            <span>{parsed.title}</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span>{parsed.language}</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span>{formatBytes(file.size)}</span>
          </div>
        </div>

        {/* Status pill */}
        <span
          data-testid="poc-card-status"
          style={{
            padding: "3px 10px",
            borderRadius: "10px",
            fontSize: "11px",
            fontWeight: 600,
            background: "var(--bg-success)",
            color: "var(--bg-success-text)",
            lineHeight: 1.4,
            flexShrink: 0,
          }}
        >
          {i18n.t("poc.status.ready")}
        </span>

        {/* Expand chevron */}
        <Icon
          name={expanded ? "chevron-up" : "chevron-down"}
          size={16}
          style={{ color: "var(--text-secondary)", flexShrink: 0 }}
        />
      </div>

      {/* Expanded body */}
      {expanded ? (
        <div
          data-testid="poc-card-body"
          style={{ borderTop: "1px solid var(--divider)" }}
        >
          {isLoading ? (
            <div style={{ padding: "24px", color: "var(--text-secondary)", fontSize: 13 }}>
              {i18n.t("poc.loadingFile")}
            </div>
          ) : error ? (
            <div style={{ padding: "24px", color: "var(--brand)", fontSize: 13 }}>
              {i18n.t("poc.errorFile")}: {(error as Error).message}
            </div>
          ) : (
            <>
              {/* Code block */}
              <pre
                data-testid="poc-card-code"
                style={{
                  margin: 0,
                  padding: "18px 20px",
                  background: "var(--code-bg)",
                  color: "var(--code-text)",
                  fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                  fontSize: "12px",
                  lineHeight: 1.7,
                  maxHeight: "360px",
                  overflow: "auto",
                  whiteSpace: "pre",
                }}
              >
                {fileData?.content ?? ""}
              </pre>

              {/* Action row */}
              <div
                style={{
                  display: "flex",
                  gap: "8px",
                  padding: "12px 20px",
                  borderTop: "1px solid var(--divider)",
                  background: "var(--bg-card)",
                }}
              >
                <button
                  type="button"
                  data-testid="poc-card-copy"
                  onClick={handleCopy}
                  style={BTN_BASE}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "var(--bg-hover)")
                  }
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <Icon name={copied ? "check" : "copy"} size={13} />
                  <span>{copied ? i18n.t("poc.copied") : i18n.t("poc.copy")}</span>
                </button>
                <button
                  type="button"
                  data-testid="poc-card-download"
                  onClick={handleDownload}
                  style={BTN_BASE}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "var(--bg-hover)")
                  }
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <Icon name="upload" size={13} style={{ transform: "rotate(180deg)" }} />
                  <span>{i18n.t("poc.download")}</span>
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

const BTN_BASE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  padding: "6px 12px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  background: "transparent",
  color: "var(--text-secondary)",
  fontSize: "12px",
  fontWeight: 500,
  cursor: "pointer",
  transition: "background 0.12s, color 0.12s",
  lineHeight: 1,
};

/* -------------------------------------------------------------------------- */
/*  Empty / loading state                                                     */
/* -------------------------------------------------------------------------- */

function EmptyState({
  text,
  muted,
  variant,
}: {
  text: string;
  muted?: boolean;
  variant?: "error";
}) {
  return (
    <div
      data-testid="poc-empty"
      style={{
        padding: "48px 24px",
        textAlign: "center",
        fontSize: "13px",
        color:
          variant === "error"
            ? "var(--brand)"
            : muted
              ? "var(--text-secondary)"
              : "var(--text-primary)",
        background: "var(--bg-card)",
        border: "1px dashed var(--border)",
        borderRadius: "12px",
      }}
    >
      {text}
    </div>
  );
}
