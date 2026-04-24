import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { useOutletContext, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type FindingDetail as FindingDetailData,
  type FindingMeta,
  type Task,
  type WorkspaceFile,
  type WorkspaceTreeNode,
} from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";
import { Icon } from "../../../../shared/components/Icon.js";

/* -------------------------------------------------------------------------- */
/*  Severity helpers                                                          */
/* -------------------------------------------------------------------------- */

const SEV_COLORS: Record<string, string> = {
  critical: "var(--sev-high)",
  high: "var(--sev-high)",
  medium: "var(--sev-medium)",
  low: "var(--sev-low)",
  info: "var(--sev-info)",
};

/** Severity ranking for max-severity rollup in file tree. Higher = worse. */
const SEV_RANK: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function maxSeverity(a: string | null, b: string): string {
  if (!a) return b;
  return (SEV_RANK[b] ?? 0) > (SEV_RANK[a] ?? 0) ? b : a;
}

function normalizePath(raw: string): string {
  return raw.replace(/^\/+workspace\/+/, "").replace(/^\/+/, "");
}

/* -------------------------------------------------------------------------- */
/*  File tree aggregation                                                     */
/* -------------------------------------------------------------------------- */

interface FlatFileNode {
  name: string;
  path: string;
  depth: number;
  isDir: boolean;
  vulnCount: number;
  vulnSeverity: string | null; // max severity for marker color
  collapsed: boolean;
}

/**
 * Flatten the backend tree, annotating each node with aggregated
 * vulnerability count + max-severity (rolled up to directories).
 */
function flattenFindingsTree(
  tree: WorkspaceTreeNode[],
  findings: FindingMeta[],
  collapsed: Set<string>,
): FlatFileNode[] {
  // Build path → (count, maxSev) lookup from findings.
  const byPath = new Map<string, { count: number; maxSev: string }>();
  for (const f of findings) {
    const raw = normalizePath(f.primary_file ?? "");
    if (!raw) continue;
    const sev = (f.severity ?? "info").toLowerCase();
    const slot = byPath.get(raw);
    if (slot) {
      slot.count += 1;
      slot.maxSev = maxSeverity(slot.maxSev, sev)!;
    } else {
      byPath.set(raw, { count: 1, maxSev: sev });
    }
  }

  const out: FlatFileNode[] = [];

  function walk(
    nodes: WorkspaceTreeNode[],
    depth: number,
    parentPath: string,
    target: FlatFileNode[],
  ): { count: number; maxSev: string | null } {
    let dirCount = 0;
    let dirSev: string | null = null;

    for (const node of nodes) {
      const path = parentPath ? `${parentPath}/${node.name}` : node.name;
      const isDir =
        node.type === "dir" || !!(node.children && node.children.length > 0);

      if (isDir) {
        const sub: FlatFileNode[] = [];
        const rollup = walk(node.children ?? [], depth + 1, path, sub);
        const isCollapsed = collapsed.has(path);
        target.push({
          name: node.name,
          path,
          depth,
          isDir: true,
          vulnCount: rollup.count,
          vulnSeverity: rollup.maxSev,
          collapsed: isCollapsed,
        });
        if (!isCollapsed) target.push(...sub);
        dirCount += rollup.count;
        if (rollup.maxSev)
          dirSev = maxSeverity(dirSev, rollup.maxSev) ?? dirSev;
      } else {
        // Try exact path match, then suffix match
        let hit = byPath.get(path);
        if (!hit) {
          for (const [fp, slot] of byPath) {
            if (path.endsWith("/" + fp) || fp.endsWith("/" + path)) {
              hit = slot;
              break;
            }
          }
        }
        target.push({
          name: node.name,
          path,
          depth,
          isDir: false,
          vulnCount: hit?.count ?? 0,
          vulnSeverity: hit?.maxSev ?? null,
          collapsed: false,
        });
        if (hit) {
          dirCount += hit.count;
          dirSev = maxSeverity(dirSev, hit.maxSev) ?? dirSev;
        }
      }
    }

    return { count: dirCount, maxSev: dirSev };
  }

  walk(tree, 0, "", out);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function FindingsTab() {
  const { task } = useOutletContext<{ task: Task }>();
  const [, forceUpdate] = useState(0);
  useEffect(() => i18n.onChange(() => forceUpdate((n) => n + 1)), []);

  // Deep-link support: ?bug=BUG-001 (from Overview Key Findings click)
  // selects the matching finding once data loads.
  const initialBugParam = (() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("bug");
  })();

  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    null,
  );
  /** Active file filter. When set, left list shows only findings in this file. */
  const [fileFilter, setFileFilter] = useState<string | null>(null);
  /** Explicitly view a non-vuln file in right panel (not a finding). */
  const [nonVulnFile, setNonVulnFile] = useState<string | null>(null);
  const [treeCollapsed, setTreeCollapsed] = useState<Set<string>>(new Set());

  const LEFT_PANEL_WIDTH = 260; // px — Group A (content-right Tabs)

  /** Right-side view: detail (7-section YAML) or code+files (inline split). */
  const [rightView, setRightView] = useState<"detail" | "code">("detail");

  /* -------- Data queries -------- */

  const { data: findingsData, isLoading: findingsLoading } = useQuery({
    queryKey: ["findings", task.id, severityFilter],
    queryFn: () =>
      api.findings.list(
        task.id,
        severityFilter === "all" ? undefined : severityFilter,
      ),
  });

  const { data: treeData } = useQuery({
    queryKey: ["workspace-tree", task.id],
    queryFn: () => api.tasks.workspaceTree(task.id),
    staleTime: 60_000,
    retry: false,
  });

  const allFindings = findingsData?.findings ?? [];

  // Apply ?bug=KEY deep-link once data is available. Runs only when nothing
  // is selected yet to avoid clobbering subsequent user clicks.
  useEffect(() => {
    if (!initialBugParam) return;
    if (selectedFindingId) return;
    const match = allFindings.find((f) => f.finding_key === initialBugParam);
    if (match) setSelectedFindingId(match.id);
  }, [initialBugParam, allFindings, selectedFindingId]);

  /* -------- Filtered findings (left panel) -------- */

  const filteredFindings = useMemo(() => {
    if (!fileFilter) return allFindings;
    return allFindings.filter((f) => {
      const fp = normalizePath(f.primary_file ?? "");
      // Exact match or suffix match (zip root prefix may differ)
      return fp === fileFilter || fileFilter.endsWith("/" + fp) || fp.endsWith("/" + fileFilter);
    });
  }, [allFindings, fileFilter]);

  // When the filter changes and current selection is out of scope, re-select first match.
  useEffect(() => {
    if (!fileFilter) return;
    if (filteredFindings.length === 0) {
      setSelectedFindingId(null);
      return;
    }
    const current = filteredFindings.find((f) => f.id === selectedFindingId);
    if (!current) setSelectedFindingId(filteredFindings[0].id);
  }, [fileFilter, filteredFindings, selectedFindingId]);

  const selectedFinding = useMemo(
    () => allFindings.find((f) => f.id === selectedFindingId) ?? null,
    [allFindings, selectedFindingId],
  );

  /* -------- Right panel: resolve which file to show -------- */

  const viewPath: string | null = useMemo(() => {
    if (selectedFinding?.primary_file)
      return normalizePath(selectedFinding.primary_file);
    return nonVulnFile;
  }, [selectedFinding, nonVulnFile]);

  const { data: fileData, isLoading: fileLoading } = useQuery<WorkspaceFile>({
    queryKey: ["workspace-file", task.id, viewPath],
    queryFn: () => api.tasks.workspaceFile(task.id, viewPath!),
    enabled: !!viewPath,
    staleTime: 5 * 60_000,
  });

  /* -------- Vuln line decorations for current viewPath -------- */

  const vulnLineSet = useMemo(() => {
    const set = new Set<number>();
    if (!viewPath) return set;
    (fileData?.vuln_decorations ?? []).forEach((d) => set.add(d.line));
    // Fallback: derive from findings list matching current path.
    if (set.size === 0) {
      for (const f of allFindings) {
        if (!f.primary_line) continue;
        if (normalizePath(f.primary_file ?? "") === viewPath)
          set.add(f.primary_line);
      }
    }
    return set;
  }, [fileData, allFindings, viewPath]);

  const activeLine = selectedFinding?.primary_line ?? null;

  /* -------- Finding detail query (7-section YAML) -------- */

  const {
    data: detailData,
    isLoading: detailLoading,
    error: detailError,
  } = useQuery({
    queryKey: [
      "finding-detail",
      task.id,
      selectedFinding?.finding_key,
    ],
    queryFn: () =>
      api.findings.detail(task.id, selectedFinding!.finding_key),
    enabled: !!selectedFinding,
    staleTime: 5 * 60_000,
  });

  /* -------- File tree (middle panel) -------- */

  const flatTree = useMemo(
    () =>
      flattenFindingsTree(
        treeData?.tree ?? [],
        allFindings,
        treeCollapsed,
      ),
    [treeData, allFindings, treeCollapsed],
  );

  function toggleDir(path: string) {
    setTreeCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /* -------- Interaction handlers -------- */

  function handlePickFinding(f: FindingMeta) {
    setSelectedFindingId((cur) => (cur === f.id ? null : f.id));
    setNonVulnFile(null);
  }

  function handlePickTreeNode(node: FlatFileNode) {
    if (node.isDir) {
      toggleDir(node.path);
      return;
    }
    if (node.vulnCount > 0) {
      // Vulnerable file → filter left list, auto-select first.
      setFileFilter(node.path);
      setNonVulnFile(null);
      // selectedFindingId will be auto-set by the useEffect above.
    } else {
      // Non-vuln file → clear filter + finding, just display file.
      setFileFilter(null);
      setSelectedFindingId(null);
      setNonVulnFile(node.path);
    }
  }

  function clearFilter() {
    setFileFilter(null);
  }


  /* -------- Render -------- */

  return (
    <div data-testid="task-detail-panel-findings" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%" }}>
      {/* Two-column container — rounded white card on gray page */}
      <div
        data-testid="findings-two-col"
        style={{
          display: "flex",
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "10px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        {/* Left: findings list */}
        <div
          data-testid="findings-list-panel"
          style={{
            width: `${LEFT_PANEL_WIDTH}px`,
            flexShrink: 0,
            overflow: "auto",
            borderRight: "1px solid var(--border)",
            background: "var(--bg-page)",
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
      {/* Filter bar — inside left panel header, one row */}
      <div
        style={{
          display: "flex",
          gap: "4px",
          padding: "10px 12px",
          borderBottom: "1px solid var(--divider)",
          alignItems: "center",
          flexWrap: "nowrap",
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        {(["all", "high", "medium", "low", "info"] as const).map((s) => (
          <button
            key={s}
            data-testid={`findings-filter-${s}`}
            onClick={() => setSeverityFilter(s)}
            style={{
              padding: "3px 9px",
              border: `1px solid ${
                severityFilter === s && s !== "all"
                  ? SEV_COLORS[s]
                  : severityFilter === s
                    ? "var(--brand)"
                    : "var(--border)"
              }`,
              borderRadius: "999px",
              background:
                severityFilter === s ? "var(--bg-active-filter)" : "transparent",
              color:
                s === "all"
                  ? severityFilter === "all"
                    ? "var(--brand)"
                    : "var(--text-secondary)"
                  : severityFilter === s
                    ? SEV_COLORS[s]
                    : "var(--text-secondary)",
              fontSize: "11px",
              fontWeight: 500,
              cursor: "pointer",
              flexShrink: 0,
              whiteSpace: "nowrap",
              fontFamily: "inherit",
            }}
          >
            {s === "all"
              ? i18n.t("findings.filterAll")
              : i18n.t(
                  `findings.sev${s.charAt(0).toUpperCase()}${s.slice(1)}`,
                )}
          </button>
        ))}
        {fileFilter && (
          <button
            data-testid="findings-clear-filter"
            onClick={clearFilter}
            title={fileFilter.split("/").pop() ?? fileFilter}
            style={{
              marginLeft: "auto",
              border: "none",
              background: "transparent",
              color: "var(--brand)",
              fontSize: "11px",
              cursor: "pointer",
              padding: "0 4px",
              flexShrink: 0,
              fontFamily: "inherit",
            }}
          >
            ✕ {i18n.t("findings.clearFilter")}
          </button>
        )}
      </div>

          {/* Findings list body */}
          <div style={{ flex: 1, overflow: "auto" }}>
          {findingsLoading ? (
            <div style={MSG_STYLE}>{i18n.t("findings.loading")}</div>
          ) : filteredFindings.length === 0 ? (
            <div style={MSG_STYLE}>{i18n.t("findings.empty")}</div>
          ) : (
            filteredFindings.map((f) => (
              <FindingRow
                key={f.id}
                finding={f}
                selected={selectedFindingId === f.id}
                onClick={() => {
                  handlePickFinding(f);
                  setRightView("detail");
                }}
              />
            ))
          )}
        </div>
        </div>{/* end left panel */}


        {/* ================================================================ */}
        {/*  Right: Tab-switched panel — Detail / Code / Files               */}
        {/* ================================================================ */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            background: "var(--bg-card)",
          }}
        >
          {/* Tab bar */}
          <div
            data-testid="findings-right-tabs"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0",
              borderBottom: "1px solid var(--divider)",
              background: "var(--bg-card)",
              flexShrink: 0,
            }}
          >
            {(["detail", "code"] as const).map((tab) => {
              const active = rightView === tab;
              const label =
                tab === "detail"
                  ? i18n.t("findings.tab.detail")
                  : i18n.t("findings.tab.code");
              return (
                <button
                  key={tab}
                  type="button"
                  data-testid={`findings-tab-${tab}`}
                  onClick={() => setRightView(tab)}
                  style={{
                    padding: "10px 18px",
                    border: "none",
                    borderBottom: active
                      ? "2px solid var(--brand)"
                      : "2px solid transparent",
                    background: "transparent",
                    color: active
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                    fontSize: "12.5px",
                    fontWeight: active ? 600 : 400,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "color 0.12s, border-color 0.12s",
                  }}
                >
                  {label}
                </button>
              );
            })}
            {/* File filter chip (shown when a file is active) */}
            {fileFilter && (
              <span
                style={{
                  marginLeft: "auto",
                  marginRight: "12px",
                  fontSize: "11px",
                  color: "var(--text-secondary)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                {fileFilter.split("/").pop()}
                <button
                  type="button"
                  onClick={clearFilter}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "var(--brand)",
                    cursor: "pointer",
                    padding: "0 2px",
                    fontSize: "11px",
                    fontFamily: "inherit",
                  }}
                >
                  ×
                </button>
              </span>
            )}
          </div>

          {/* Tab content — only one rendered at a time */}
          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            {rightView === "detail" && (
              selectedFinding ? (
                <FindingDetailPanel
                  taskId={task.id}
                  finding={selectedFinding}
                  detail={detailData?.detail}
                  loading={detailLoading}
                  error={detailError as Error | null}
                  onViewCode={() => setRightView("code")}
                />
              ) : (
                <EmptyState icon="shield" text={i18n.t("findings.detail.placeholder")} />
              )
            )}

            {rightView === "code" && (
              <div
                style={{
                  display: "flex",
                  flex: 1,
                  minHeight: 0,
                }}
              >
                {/* Inline file tree (left side of code tab) */}
                <div
                  data-testid="findings-file-tree"
                  style={{
                    width: "220px",
                    flexShrink: 0,
                    overflow: "auto",
                    borderRight: "1px solid var(--border)",
                    background: "var(--bg-page)",
                    padding: "6px 0",
                  }}
                >
                  {!treeData || (treeData.tree ?? []).length === 0 ? (
                    allFindings.length === 0 ? (
                      <EmptyState
                        icon="shield"
                        text={i18n.t("findings.noVulnFiles")}
                      />
                    ) : (
                      <div style={MSG_STYLE}>
                        {i18n.t("findings.filesEmpty")}
                      </div>
                    )
                  ) : (
                    flatTree.map((n) => (
                      <FileTreeRow
                        key={n.path}
                        node={n}
                        selected={
                          (viewPath ?? "") === n.path ||
                          (fileFilter ?? "") === n.path
                        }
                        onClick={() => handlePickTreeNode(n)}
                      />
                    ))
                  )}
                </div>
                {/* Code viewer (right side of code tab) */}
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                  {viewPath ? (
                    <CodeViewer
                      path={viewPath}
                      file={fileData}
                      loading={fileLoading}
                      vulnLines={vulnLineSet}
                      activeLine={activeLine}
                    />
                  ) : (
                    <EmptyCodePlaceholder />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sub-components                                                            */
/* -------------------------------------------------------------------------- */

const MSG_STYLE: React.CSSProperties = {
  padding: "24px",
  color: "var(--text-secondary)",
  fontSize: "13px",
};

function FindingRow({
  finding: f,
  selected,
  onClick,
}: {
  finding: FindingMeta;
  selected: boolean;
  onClick: () => void;
}) {
  const sev = (f.severity ?? "info").toLowerCase();
  return (
    <div
      data-testid="finding-row"
      data-finding-id={f.id}
      data-severity={sev}
      data-selected={selected || undefined}
      onClick={onClick}
      style={{
        padding: "10px 16px",
        cursor: "pointer",
        background: selected ? "var(--bg-card)" : "transparent",
        borderLeft: selected
          ? "2px solid var(--brand)"
          : "2px solid transparent",
        transition: "background 0.12s, border-color 0.12s",
      }}
    >
      <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: SEV_COLORS[sev] ?? SEV_COLORS.info,
            flexShrink: 0,
            marginTop: "4px",
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: "12px",
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {f.finding_key}
          </div>
          <div
            style={{
              fontSize: "11px",
              color: "var(--text-secondary)",
              marginTop: "2px",
            }}
          >
            {f.vuln_type_full ?? f.vuln_type ?? ""}
          </div>
          {f.primary_file && (
            <div
              style={{
                fontSize: "11px",
                color: "var(--text-secondary)",
                fontFamily: "monospace",
                marginTop: "2px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {normalizePath(f.primary_file)}
              {f.primary_line ? `:${f.primary_line}` : ""}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileTreeRow({
  node,
  selected,
  onClick,
}: {
  node: FlatFileNode;
  selected: boolean;
  onClick: () => void;
}) {
  const markerColor =
    node.vulnSeverity && SEV_COLORS[node.vulnSeverity]
      ? SEV_COLORS[node.vulnSeverity]
      : "var(--brand)";
  return (
    <div
      data-testid="findings-file-tree-row"
      data-file-path={node.path}
      data-is-dir={node.isDir || undefined}
      data-has-vuln={node.vulnCount > 0 || undefined}
      data-selected={selected || undefined}
      data-severity={node.vulnSeverity ?? undefined}
      data-count={node.vulnCount || undefined}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "4px 12px",
        paddingLeft: `${12 + node.depth * 14}px`,
        cursor: "pointer",
        fontSize: "12px",
        color: selected
          ? "var(--text-primary)"
          : node.isDir
            ? "var(--text-primary)"
            : "var(--text-secondary)",
        fontWeight: node.isDir ? 600 : selected ? 500 : 400,
        background: selected ? "var(--border)" : "transparent",
        borderLeft: selected
          ? "2px solid var(--brand)"
          : "2px solid transparent",
        lineHeight: 1.6,
        userSelect: "none",
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
    >
      {node.isDir ? (
        <Icon
          name={node.collapsed ? "chevron-right" : "chevron-down"}
          size={12}
          style={{ color: "var(--text-secondary)", flexShrink: 0 }}
        />
      ) : (
        <Icon
          name="file-text"
          size={12}
          style={{
            color: "var(--text-secondary)",
            flexShrink: 0,
            opacity: 0.7,
          }}
        />
      )}

      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {node.name}
        {node.isDir ? "/" : ""}
      </span>

      {/* Vuln badge: dot + count */}
      {node.vulnCount > 0 && (
        <span
          data-testid="findings-file-decor"
          data-severity={node.vulnSeverity ?? undefined}
          data-count={node.vulnCount}
          title={i18n
            .t("findings.vulnsInFile")
            .replace("{n}", String(node.vulnCount))}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            flexShrink: 0,
            color: "var(--text-secondary)",
            fontSize: "11px",
            fontFeatureSettings: "'tnum'",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: markerColor,
              display: "inline-block",
            }}
          />
          {node.vulnCount > 99 ? "99+" : node.vulnCount}
        </span>
      )}
    </div>
  );
}

function CodeViewer({
  path,
  file,
  loading,
  vulnLines,
  activeLine,
}: {
  path: string;
  file: WorkspaceFile | undefined;
  loading: boolean;
  vulnLines: Set<number>;
  activeLine: number | null;
}) {
  const streamRef = useRef<HTMLDivElement | null>(null);

  // Scroll target line into view when selection changes.
  useEffect(() => {
    if (!file) return;
    const target =
      activeLine ?? (vulnLines.size > 0 ? Math.min(...Array.from(vulnLines)) : null);
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
        data-testid="findings-code-header"
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
      </div>

      <div
        ref={streamRef}
        data-testid="findings-code-body"
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--code-bg)",
          color: "var(--code-text)",
          fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          fontSize: "12px",
          lineHeight: 1.7,
          padding: "8px 0",
        }}
      >
        {loading ? (
          <div style={{ padding: "24px", color: "#737373", fontSize: "12px" }}>
            {i18n.t("workspace.loading.file")}
          </div>
        ) : file?.type === "binary" ? (
          <div style={{ padding: "24px", color: "#737373", fontSize: "12px" }}>
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
                data-testid={isVuln ? "findings-vuln-line" : undefined}
                data-active={isActive || undefined}
                style={{
                  display: "flex",
                  padding: "0 14px",
                  background: isVuln ? "rgba(220,38,38,0.14)" : "transparent",
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
                    color: "#555",
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

function EmptyCodePlaceholder() {
  return (
    <div
      data-testid="findings-code-empty"
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
      <span>{i18n.t("findings.selectToView")}</span>
    </div>
  );
}

function EmptyState({
  icon,
  text,
}: {
  icon: "shield";
  text: string;
}) {
  return (
    <div
      data-testid="findings-empty-state"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: "var(--text-secondary)",
        gap: "10px",
        padding: "24px",
      }}
    >
      <Icon name={icon} size={28} style={{ opacity: 0.4 }} />
      <span style={{ fontSize: "13px" }}>{text}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Finding Detail Panel — renders the 7-section YAML as an accordion         */
/* -------------------------------------------------------------------------- */

function FindingDetailPanel({
  taskId,
  finding,
  detail,
  loading,
  error,
  onViewCode,
}: {
  taskId: string;
  finding: FindingMeta;
  detail: FindingDetailData | undefined;
  loading: boolean;
  error: Error | null;
  /** Switch to the code tab within the same page (two-column layout). */
  onViewCode?: () => void;
}) {
  const navigate = useNavigate();
  const sev = (finding.severity ?? "info").toLowerCase();
  const sevColor = SEV_COLORS[sev] ?? SEV_COLORS.info;

  if (loading) {
    return (
      <div style={DETAIL_MSG_STYLE}>
        {i18n.t("findings.detail.loading")}
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ ...DETAIL_MSG_STYLE, color: "var(--brand)" }}>
        {i18n.t("findings.detail.error")}: {error.message}
      </div>
    );
  }
  if (!detail) {
    return (
      <div style={DETAIL_MSG_STYLE}>
        {i18n.t("findings.detail.placeholder")}
      </div>
    );
  }

  // youngflow's YAML uses `vulnerability` for the core vuln metadata.
  // Some scanners still emit the schema-v1 `metadata` structure. Fall back.
  const vuln = (detail.vulnerability ?? detail.metadata ?? {}) as Record<string, unknown>;
  const refs = detail.references ?? [];
  const strFromField = (obj: Record<string, unknown>, ...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.length > 0) return v;
      if (typeof v === "number") return String(v);
    }
    return undefined;
  };

  return (
    <div style={{ padding: "12px 16px", fontSize: "13px" }}>
      {/* Sticky header: severity + BUG-ID + title */}
      <div
        data-testid="finding-detail-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          paddingBottom: "10px",
          marginBottom: "12px",
          borderBottom: "1px solid var(--divider)",
        }}
      >
        <span
          style={{
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            background: sevColor,
            flexShrink: 0,
          }}
        />
        <span style={{ fontWeight: 600, fontSize: "14px", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {finding.finding_key}
        </span>
        <span
          style={{
            fontSize: "11px",
            fontWeight: 600,
            color: sevColor,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
          }}
        >
          {sev}
        </span>
        {finding.primary_file ? (
          <button
            type="button"
            data-testid="finding-view-in-code"
            title={i18n.t("findings.viewInCode")}
            onClick={() => {
              if (onViewCode) {
                // Same-page: switch to code tab within the two-column layout.
                onViewCode();
              } else {
                // Cross-page fallback: navigate to workspace tab.
                const params = new URLSearchParams();
                params.set("file", normalizePath(finding.primary_file!));
                if (finding.primary_line) params.set("line", String(finding.primary_line));
                navigate(`/tasks/${taskId}/workspace?${params.toString()}`);
              }
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "3px 8px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-secondary)",
              fontSize: "11px",
              cursor: "pointer",
              flexShrink: 0,
              transition: "all 0.12s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--brand)";
              e.currentTarget.style.color = "var(--brand)";
              e.currentTarget.style.background = "var(--bg-error)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--border)";
              e.currentTarget.style.color = "var(--text-secondary)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <Icon name="code" size={12} strokeWidth={2.5} />
            {i18n.t("findings.viewInCode")}
          </button>
        ) : null}
      </div>

      {/* Metadata row (inline, always visible) */}
      <div
        data-testid="finding-section-metadata"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: "6px 16px",
          marginBottom: "14px",
        }}
      >
        <MetaField
          label={i18n.t("findings.field.vulnType")}
          value={strFromField(vuln, "vuln_type_full_name", "vuln_type")}
        />
        <MetaField label={i18n.t("findings.field.function")} value={strFromField(vuln, "function")} mono />
        <MetaField label={i18n.t("findings.field.language")} value={strFromField(vuln, "language")} />
        <MetaField
          label={i18n.t("findings.field.permission")}
          value={strFromField(vuln, "permission_requirement")}
        />
        <MetaField label={i18n.t("findings.field.source")} value={strFromField(vuln, "source")} mono />
        <MetaField label={i18n.t("findings.field.sink")} value={strFromField(vuln, "sink")} mono />
      </div>

      <FlexibleSection
        testid="finding-section-description"
        title={i18n.t("findings.section.description")}
        raw={detail.description}
        defaultOpen
        structuredFields={[
          [i18n.t("findings.field.entryPoint"), "entry_point"],
          [i18n.t("findings.field.taintSource"), "taint_source"],
          [i18n.t("findings.field.trigger"), "trigger_condition"],
        ]}
        leadingField="detailed_description"
      />

      <FlexibleSection
        testid="finding-section-code"
        title={i18n.t("findings.section.code")}
        raw={detail.code}
        defaultOpen
        codeTone="bad"
        structuredCodePairs={[
          [i18n.t("findings.field.vulnerableCode"), "vulnerable_code", "bad"],
          [i18n.t("findings.field.fixCode"), "fix_code", "good"],
        ]}
      />

      <FlexibleSection
        testid="finding-section-dataflow"
        title={i18n.t("findings.section.dataFlow")}
        raw={detail.data_flow}
      />

      <FlexibleSection
        testid="finding-section-attack"
        title={i18n.t("findings.section.attack")}
        raw={detail.attack}
        structuredFields={[
          [i18n.t("findings.field.payload"), "attack_payload_example", { code: true, tone: "neutral" }],
        ]}
        leadingField="attack_description"
      />

      <FlexibleSection
        testid="finding-section-remediation"
        title={i18n.t("findings.section.remediation")}
        raw={detail.remediation}
        structuredFields={[
          [i18n.t("findings.field.fixCode"), "fix_code_example", { code: true, tone: "good" }],
        ]}
        leadingField="fix_recommendation"
      />

      {refs.length > 0 && (
        <Section testid="finding-section-references" title={i18n.t("findings.section.references")}>
          <ul style={{ margin: 0, paddingLeft: "20px", fontSize: "12px" }}>
            {refs.map((ref, i) => {
              // ref can be a string URL, or an object like { "OWASP": "Callback Injection" } / { "CWE-115": "..." }
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
        </Section>
      )}
    </div>
  );
}

/**
 * Renders a section whose data may be either a plain string (youngflow
 * current output) or a structured object (bug-report schema v1 format).
 */
function FlexibleSection({
  testid,
  title,
  raw,
  defaultOpen,
  leadingField,
  structuredFields,
  structuredCodePairs,
  codeTone,
}: {
  testid: string;
  title: string;
  raw: unknown;
  defaultOpen?: boolean;
  /** If raw is an object, render this field (if present) as a leading paragraph. */
  leadingField?: string;
  /** Structured field renderers: [label, key, options?] */
  structuredFields?: Array<
    | [string, string]
    | [string, string, { code?: boolean; tone?: "bad" | "good" | "neutral" }]
  >;
  /** Pairs of code blocks (e.g. vulnerable_code + fix_code). */
  structuredCodePairs?: Array<[string, string, "bad" | "good" | "neutral"]>;
  /** Tone to use when raw itself is a string and should be rendered as code. */
  codeTone?: "bad" | "good" | "neutral";
}) {
  // Nothing to render for undefined / null / empty
  if (raw == null) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;

  let body: React.ReactNode = null;

  if (typeof raw === "string") {
    // Heuristic: contains multiple lines or a recognizable code pattern → code block.
    // Otherwise render as pre-wrap paragraph.
    const hasCodeMarkers = /^\s*(\/\/|#|\{|function |void |class |def |<)/m.test(raw) ||
      /;\s*$/m.test(raw);
    if (codeTone || hasCodeMarkers) {
      body = <CodeBlock content={raw} tone={codeTone ?? "neutral"} />;
    } else {
      body = <p style={PARA_STYLE}>{raw}</p>;
    }
  } else if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const leadingVal = leadingField ? obj[leadingField] : undefined;
    const extras: React.ReactNode[] = [];
    if (typeof leadingVal === "string" && leadingVal) {
      extras.push(<p key="lead" style={PARA_STYLE}>{leadingVal}</p>);
    }
    if (structuredCodePairs) {
      for (const [label, key, tone] of structuredCodePairs) {
        const v = obj[key];
        if (typeof v === "string" && v) {
          extras.push(
            <div key={key} style={{ marginTop: "10px" }}>
              <div style={SUBLABEL_STYLE}>{label}</div>
              <CodeBlock content={v} tone={tone} />
            </div>,
          );
        }
      }
    }
    if (structuredFields) {
      const rows: React.ReactNode[] = [];
      for (const spec of structuredFields) {
        const [label, key, opts] = spec as [string, string, { code?: boolean; tone?: "bad" | "good" | "neutral" } | undefined];
        const v = obj[key];
        if (v == null || v === "") continue;
        if (opts?.code && typeof v === "string") {
          extras.push(
            <div key={key} style={{ marginTop: "8px" }}>
              <div style={SUBLABEL_STYLE}>{label}</div>
              <CodeBlock content={v} tone={opts.tone ?? "neutral"} />
            </div>,
          );
        } else {
          rows.push(
            <Fragment key={key}>
              <span style={LABEL_STYLE}>{label}</span>
              <span style={VALUE_STYLE}>{String(v)}</span>
            </Fragment>,
          );
        }
      }
      if (rows.length > 0) {
        extras.push(
          <div
            key="rows"
            style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 12px", marginTop: "10px" }}
          >
            {rows}
          </div>,
        );
      }
    }
    if (extras.length === 0) {
      // Fallback: dump remaining string-valued keys as label/value rows.
      const rows: React.ReactNode[] = [];
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && v) {
          rows.push(
            <Fragment key={k}>
              <span style={LABEL_STYLE}>{k}</span>
              <span style={VALUE_STYLE}>{v}</span>
            </Fragment>,
          );
        }
      }
      if (rows.length === 0) return null;
      body = (
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 12px" }}>{rows}</div>
      );
    } else {
      body = <>{extras}</>;
    }
  }

  return (
    <Section testid={testid} title={title} defaultOpen={defaultOpen}>
      {body}
    </Section>
  );
}

/* ---- Finding detail sub-primitives ---- */

const DETAIL_MSG_STYLE: React.CSSProperties = {
  padding: "32px 16px",
  textAlign: "center",
  color: "var(--text-secondary)",
  fontSize: "12px",
};

const LABEL_STYLE: React.CSSProperties = {
  fontSize: "11px",
  color: "var(--text-secondary)",
  fontWeight: 500,
  whiteSpace: "nowrap",
};
const VALUE_STYLE: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--text-primary)",
  lineHeight: 1.6,
  wordBreak: "break-word",
};
const SUBLABEL_STYLE: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--text-secondary)",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  marginBottom: "4px",
};
const PARA_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: "12.5px",
  lineHeight: 1.65,
  color: "var(--text-primary)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

function MetaField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | number | undefined;
  mono?: boolean;
}) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={LABEL_STYLE}>{label}</div>
      <div
        style={{
          ...VALUE_STYLE,
          fontFamily: mono
            ? "'SF Mono', Menlo, Consolas, monospace"
            : undefined,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={String(value)}
      >
        {value}
      </div>
    </div>
  );
}

function Section({
  testid,
  title,
  defaultOpen,
  children,
}: {
  testid: string;
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <section
      data-testid={testid}
      data-open={open || undefined}
      style={{
        borderTop: "1px solid var(--divider)",
        padding: "10px 0",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "6px",
          width: "100%",
          textAlign: "left",
          color: "var(--text-primary)",
          fontSize: "13px",
          fontWeight: 600,
        }}
      >
        <Icon
          name={open ? "chevron-down" : "chevron-right"}
          size={12}
          style={{ color: "var(--text-secondary)" }}
        />
        <span>{title}</span>
      </button>
      {open && <div style={{ marginTop: "8px", paddingLeft: "18px" }}>{children}</div>}
    </section>
  );
}

function CodeBlock({
  content,
  tone,
}: {
  content: string;
  tone: "bad" | "good" | "neutral";
}) {
  const bg =
    tone === "bad"
      ? "rgba(220,38,38,0.08)"
      : tone === "good"
        ? "rgba(34,197,94,0.08)"
        : "var(--terminal-bg, #0a0a0a)";
  const border =
    tone === "bad"
      ? "1px solid rgba(220,38,38,0.3)"
      : tone === "good"
        ? "1px solid rgba(34,197,94,0.3)"
        : "1px solid var(--border)";
  return (
    <pre
      style={{
        margin: "6px 0 0 0",
        padding: "10px 12px",
        background: bg,
        border,
        borderRadius: "6px",
        fontFamily: "'SF Mono', Menlo, Consolas, monospace",
        fontSize: "12px",
        lineHeight: 1.55,
        color: "var(--text-primary)",
        overflowX: "auto",
        whiteSpace: "pre",
        maxHeight: "220px",
      }}
    >
      {content}
    </pre>
  );
}
