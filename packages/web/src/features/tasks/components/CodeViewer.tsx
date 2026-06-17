import { useEffect, useMemo, useRef } from "react";
import type { WorkspaceFile } from "../../../shared/api/client.js";
import { Icon } from "../../../shared/components/Icon.js";
import { i18n } from "../../../shared/i18n/index.js";

export interface CodeViewerProps {
  path: string;
  file: WorkspaceFile | undefined;
  loading: boolean;
  vulnLines: Set<number>;
  error?: Error | null;
  activeLine?: number | null;
  testIdPrefix?: "workspace" | "findings";
}

export function CodeViewer({
  path,
  file,
  loading,
  vulnLines,
  error = null,
  activeLine = null,
  testIdPrefix = "workspace",
}: CodeViewerProps) {
  const streamRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!file) return;
    const target = activeLine ?? (vulnLines.size > 0 ? Math.min(...Array.from(vulnLines)) : null);
    if (!target) return;
    const t = window.setTimeout(() => {
      const el = streamRef.current?.querySelector<HTMLElement>(
        `[data-ln="${target}"]`,
      );
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
    return () => window.clearTimeout(t);
  }, [file, activeLine, vulnLines]);

  const lines = useMemo(() => (file?.content ?? "").split("\n"), [file]);

  return (
    <>
      <div
        data-testid={`${testIdPrefix}-code-header`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "8px 14px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-card)",
          fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          fontSize: "12px",
          color: "var(--text-secondary)",
          flexShrink: 0,
        }}
      >
        <span
          data-testid={`${testIdPrefix}-code-path`}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--text-primary)",
          }}
        >
          {path}
          {activeLine ? ` · ${i18n.t("workspace.lines")} ${activeLine}` : ""}
        </span>
        {file?.total_lines ? (
          <span>
            {file.total_lines.toLocaleString()} {i18n.t("workspace.lines")}
          </span>
        ) : null}
        {file?.is_truncated ? (
          <span
            style={{
              padding: "1px 8px",
              borderRadius: "3px",
              background: "rgba(220,38,38,0.15)",
              color: "var(--brand)",
              fontSize: "11px",
              fontWeight: 600,
            }}
            title={i18n.t("workspace.truncated")}
          >
            TRUNCATED
          </span>
        ) : null}
      </div>

      <div
        ref={streamRef}
        data-testid={`${testIdPrefix}-code-body`}
        translate="no"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          overscrollBehavior: "contain",
          background: "var(--code-bg)",
          color: "var(--code-text)",
          fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          fontSize: "12px",
          lineHeight: 1.7,
          padding: "8px 0",
        }}
      >
        {loading ? (
          <div style={{ padding: "24px", color: "var(--text-secondary)", fontSize: "12px" }}>
            {i18n.t("workspace.loading.file")}
          </div>
        ) : error ? (
          <div
            style={{
              padding: "24px",
              color: "var(--brand)",
              fontSize: "12px",
              whiteSpace: "pre-wrap",
            }}
          >
            {i18n.t("workspace.error.file")}: {error.message}
          </div>
        ) : file?.type === "image" && file.data_base64 && file.mime ? (
          <div
            data-testid={`${testIdPrefix}-image-preview`}
            style={{ padding: "24px", display: "flex", justifyContent: "center", alignItems: "flex-start" }}
          >
            <img
              src={`data:${file.mime};base64,${file.data_base64}`}
              alt={path ?? "preview"}
              style={{ maxWidth: "100%", maxHeight: "70vh", objectFit: "contain", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "6px" }}
            />
          </div>
        ) : file?.type === "binary" ? (
          <div style={{ padding: "24px", color: "var(--text-secondary)", fontSize: "12px" }}>
            {i18n.t("workspace.binary")}
          </div>
        ) : (
          lines.map((line, i) => {
            const ln = i + 1;
            const isVuln = vulnLines.has(ln);
            const isActive = ln === activeLine;
            return (
              <div
                key={ln}
                data-ln={ln}
                data-testid={isVuln ? `${testIdPrefix}-vuln-line` : undefined}
                data-active={isActive || undefined}
                style={{
                  display: "flex",
                  padding: "0 14px",
                  background: isVuln ? "var(--code-vuln-bg)" : "transparent",
                  borderLeft: isVuln
                    ? isActive
                      ? "4px solid var(--brand)"
                      : "3px solid var(--brand)"
                    : "3px solid transparent",
                  whiteSpace: "pre",
                }}
              >
                <span
                  style={{
                    color: "var(--code-line-number)",
                    userSelect: "none",
                    display: "inline-block",
                    width: "48px",
                    textAlign: "right",
                    marginRight: "14px",
                    flexShrink: 0,
                  }}
                >
                  {ln}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>{line}</span>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

export function EmptyCodePlaceholder({ testId = "workspace-empty", label }: { testId?: string; label?: string }) {
  return (
    <div
      data-testid={testId}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: "var(--code-comment, #555)",
        fontSize: "12px",
        fontFamily: "'SF Mono', Menlo, Consolas, monospace",
        gap: "10px",
      }}
    >
      <Icon name="code" size={28} style={{ opacity: 0.3 }} />
      <span>{label ?? i18n.t("workspace.select")}</span>
    </div>
  );
}
