import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { useOutletContext, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type FindingDetail as FindingDetailData,
  type FindingMeta,
  type FindingReviewStatus,
  type Task,
  type WorkspaceFile,
  type WorkspaceTreeNode,
} from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";
import { Icon } from "../../../../shared/components/Icon.js";
import { Splitter, useResizableWidth } from "../../../../shared/components/Splitter.js";
import { ReviewStatusBadge, ReviewStatusSelect, ReviewHistoryTimeline, ReviewNoteModal, REVIEW_STATUS_META } from "../../components/FindingReviewControls.js";
import { CodeViewer, EmptyCodePlaceholder } from "../../components/CodeViewer.js";
import { FindingDynamicCards } from "../../components/FindingDynamicCards.js";
import { FindingStageRail } from "../../components/FindingStageRail.js";

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

interface CodeTarget {
  path: string;
  line: number | null;
}

interface FindingAnchor {
  file_path?: string;
  line?: number;
  function?: string;
}

interface DataflowStep {
  step?: number | string;
  location?: string;
  description?: string;
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
  const dynamicEnabled = task.source_meta?.dynamic_enabled === true;
  const [, forceUpdate] = useState(0);
  useEffect(() => i18n.onChange(() => forceUpdate((n) => n + 1)), []);

  // Deep-link support: ?bug=BUG-001 (from Overview Key Findings click)
  // selects the matching finding once data loads.
  const initialBugParam = (() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("bug");
  })();
  const initialReviewParam = (() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("review");
  })();

  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [itemTypeFilter, setItemTypeFilter] = useState<"finding" | "risk" | "all">("finding");
  const [reviewFilter, setReviewFilter] = useState<string>(initialReviewParam ?? "all");
  const [batchMode, setBatchMode] = useState(false);
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    null,
  );
  /** Active file filter. When set, left list shows only findings in this file. */
  const [fileFilter, setFileFilter] = useState<string | null>(null);
  /** Explicitly view a non-vuln file in right panel (not a finding). */
  const [nonVulnFile, setNonVulnFile] = useState<string | null>(null);
  /** Explicit source target chosen from new-schema metadata.anchors[]. */
  const [detailCodeTarget, setDetailCodeTarget] = useState<CodeTarget | null>(null);
  const [treeCollapsed, setTreeCollapsed] = useState<Set<string>>(new Set());

  const [LEFT_PANEL_WIDTH, setLeftPanelWidth] = useResizableWidth("findings-left-width", 260, { min: 200, max: 600 });
  const splitContainerRef = useRef<HTMLDivElement>(null);

  /** Right-side view: detail (7-section YAML) or code+files (inline split). */
  const [rightView, setRightView] = useState<"detail" | "code">("detail");

  /* -------- Data queries -------- */

  const { data: findingsData, isLoading: findingsLoading } = useQuery({
    queryKey: ["findings", task.id, severityFilter, reviewFilter, itemTypeFilter],
    queryFn: () =>
      api.findings.list(task.id, {
        severity: severityFilter === "all" ? undefined : severityFilter,
        itemType: itemTypeFilter,
        reviewStatus: reviewFilter === "all" ? undefined : [reviewFilter as FindingReviewStatus],
        limit: 1000,
      }),
  });

  const itemCounts = findingsData?.counts ?? { finding: 0, risk: 0, all: 0 };

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
    const scoped = fileFilter
      ? allFindings.filter((f) => {
          const fp = normalizePath(f.primary_file ?? "");
          // Exact match or suffix match (zip root prefix may differ)
          return fp === fileFilter || fileFilter.endsWith("/" + fp) || fp.endsWith("/" + fileFilter);
        })
      : allFindings;
    // Stable partition: vulnerabilities first, risks second. Preserve the
    // service-provided severity/review order within each class.
    return [
      ...scoped.filter((f) => f.item_type !== "risk"),
      ...scoped.filter((f) => f.item_type === "risk"),
    ];
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
    if (detailCodeTarget?.path) return normalizePath(detailCodeTarget.path);
    if (selectedFinding?.primary_file)
      return normalizePath(selectedFinding.primary_file);
    return nonVulnFile;
  }, [selectedFinding, nonVulnFile, detailCodeTarget]);

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

  const activeLine = detailCodeTarget?.line ?? selectedFinding?.primary_line ?? null;

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
    setDetailCodeTarget(null);
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
      setDetailCodeTarget(null);
      // selectedFindingId will be auto-set by the useEffect above.
    } else {
      // Non-vuln file → clear filter + finding, just display file.
      setFileFilter(null);
      setSelectedFindingId(null);
      setDetailCodeTarget(null);
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
        ref={splitContainerRef}
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
            background: "var(--bg-page)",
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
      {/* Item-type segment control: 漏洞 / 风险 / 全部 */}
      <div
        data-testid="findings-itemtype-segment"
        style={{
          display: "flex",
          gap: "4px",
          padding: "10px 12px 0",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        {([
          ["finding", i18n.t("findings.itemType.finding"), itemCounts.finding],
          ["risk", i18n.t("findings.itemType.risk"), itemCounts.risk],
          ["all", i18n.t("findings.itemType.all"), itemCounts.all],
        ] as const).map(([type, label, count]) => {
          const active = itemTypeFilter === type;
          return (
            <button
              key={type}
              data-testid={`findings-itemtype-${type}`}
              onClick={() => setItemTypeFilter(type)}
              style={{
                flex: 1,
                padding: "5px 8px",
                border: `1px solid ${active ? "var(--brand)" : "var(--border)"}`,
                borderRadius: "6px",
                background: active ? "var(--bg-active-filter)" : "transparent",
                color: active ? "var(--brand)" : "var(--text-secondary)",
                fontSize: "11.5px",
                fontWeight: active ? 600 : 500,
                cursor: "pointer",
                fontFamily: "inherit",
                whiteSpace: "nowrap",
              }}
            >
              {label} ({count})
            </button>
          );
        })}
      </div>

      {/* Filter bar — inside left panel header, one row */}
      <div
        style={{
          display: "flex",
          gap: "4px",
          padding: "10px 12px",
          borderBottom: "1px solid var(--divider)",
          alignItems: "center",
          flexWrap: "wrap",
          flexShrink: 0,
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
        {/* Separator */}
        <span style={{ width: 1, height: 16, background: "var(--divider)", flexShrink: 0, margin: "0 4px" }} />
        {/* Review status pills */}
        {(["all", "pending", "confirmed", "false_positive", "ignored"] as const).map((s) => {
          const meta = s !== "all" ? REVIEW_STATUS_META[s] : null;
          const active = reviewFilter === s;
          return (
            <button
              key={`review-${s}`}
              onClick={() => setReviewFilter(s)}
              style={{
                padding: "3px 9px",
                border: `1px solid ${active && meta ? meta.color : active ? "var(--brand)" : "var(--border)"}`,
                borderRadius: "999px",
                background: active && meta ? meta.bg : active ? "var(--bg-active-filter)" : "transparent",
                color: active && meta ? meta.color : active ? "var(--brand)" : "var(--text-secondary)",
                fontSize: "11px",
                fontWeight: 500,
                cursor: "pointer",
                flexShrink: 0,
                whiteSpace: "nowrap",
                fontFamily: "inherit",
              }}
            >
              {s === "all" ? i18n.t("review.filter.all") : i18n.t(`review.status.${s}`)}
            </button>
          );
        })}
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

      {/* Batch review action bar */}
      {batchMode && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid var(--divider)", fontSize: 11 }}>
          <button
            onClick={() => { setBatchSelected(new Set(filteredFindings.map(f => f.id))); }}
            style={{ padding: "2px 8px", border: "1px solid var(--border)", borderRadius: 4, background: "transparent", color: "var(--text-secondary)", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}
          >
            {i18n.t("review.action.selectAll")}
          </button>
          <span style={{ color: "var(--text-secondary)" }}>{i18n.t("review.action.selected").replace("{count}", String(batchSelected.size))}</span>
          <span style={{ flex: 1 }} />
          <BatchReviewDropdown
            taskId={task.id}
            findingKeys={filteredFindings.filter(f => batchSelected.has(f.id)).map(f => f.finding_key)}
            disabled={batchSelected.size === 0}
            onDone={() => { setBatchMode(false); setBatchSelected(new Set()); }}
          />
          <button
            onClick={() => { setBatchMode(false); setBatchSelected(new Set()); }}
            style={{ padding: "2px 8px", border: "1px solid var(--border)", borderRadius: 4, background: "transparent", color: "var(--text-secondary)", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}
          >
            {i18n.t("review.action.cancel")}
          </button>
        </div>
      )}
      {!batchMode && (
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "4px 12px", borderBottom: "1px solid var(--divider)" }}>
          <button
            onClick={() => setBatchMode(true)}
            style={{ padding: "2px 8px", border: "1px solid var(--border)", borderRadius: 4, background: "transparent", color: "var(--text-secondary)", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}
          >
            {i18n.t("review.action.batchMode")}
          </button>
        </div>
      )}

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
                reviewFilter={reviewFilter}
                batchMode={batchMode}
                batchChecked={batchSelected.has(f.id)}
                onBatchToggle={() => {
                  setBatchSelected(prev => {
                    const next = new Set(prev);
                    if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
                    return next;
                  });
                }}
                onClick={() => {
                  handlePickFinding(f);
                  setRightView("detail");
                }}
              />
            ))
          )}
        </div>
        </div>{/* end left panel */}

        {/* Resizable splitter */}
        <Splitter
          value={LEFT_PANEL_WIDTH}
          onResize={setLeftPanelWidth}
          min={200}
          max={600}
          containerRef={splitContainerRef}
        />

        {/* ================================================================ */}
        {/*  Right: Tab-switched panel — Detail / Code / Files               */}
        {/* ================================================================ */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            minHeight: 0,
            overflow: "hidden",
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
          <div style={{ flex: 1, minHeight: 0, overflow: rightView === "code" ? "hidden" : "auto" }}>
            {rightView === "detail" && (
              selectedFinding ? (
                <FindingDetailPanel
                  taskId={task.id}
                  finding={selectedFinding}
                  detail={detailData?.detail}
                  loading={detailLoading}
                  error={detailError as Error | null}
                  dynamicEnabled={dynamicEnabled}
                  onViewCode={(target) => {
                    if (target) setDetailCodeTarget(target);
                    setRightView("code");
                  }}
                />
              ) : (
                <EmptyState icon="chevron-left" text={i18n.t("findings.detail.placeholder")} />
              )
            )}

            {rightView === "code" && (
              <div
                style={{
                  display: "flex",
                  flex: 1,
                  height: "100%",
                  minHeight: 0,
                  overflow: "hidden",
                }}
              >
                {/* Inline file tree (left side of code tab) */}
                <div
                  data-testid="findings-file-tree"
                  style={{
                    width: "220px",
                    flexShrink: 0,
                    minHeight: 0,
                    overflow: "auto",
                    overscrollBehavior: "contain",
                    borderRight: "1px solid var(--border)",
                    background: "var(--bg-page)",
                    padding: "6px 0",
                  }}
                >
                  {!treeData || (treeData.tree ?? []).length === 0 ? (
                    allFindings.length === 0 ? (
                      <EmptyState
                        icon="check"
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
                <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                  {viewPath ? (
                    <CodeViewer
                      path={viewPath}
                      file={fileData}
                      loading={fileLoading}
                      vulnLines={vulnLineSet}
                      activeLine={activeLine}
                      testIdPrefix="findings"
                    />
                  ) : (
                    <EmptyCodePlaceholder testId="findings-code-empty" label={i18n.t("findings.selectToView")} />
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

/** EV priority color mapping. P0 most urgent → P4 least. */
const EV_PRIORITY_COLORS: Record<string, string> = {
  P0: "var(--sev-high)",
  P1: "var(--sev-high)",
  P2: "var(--sev-medium)",
  P3: "var(--sev-low)",
  P4: "var(--sev-info)",
};

function EvPriorityBadge({ priority }: { priority: string }) {
  const p = priority.toUpperCase();
  const color = EV_PRIORITY_COLORS[p] ?? "var(--text-secondary)";
  return (
    <span
      data-testid="finding-ev-priority"
      title={i18n.t("findings.field.evPriority")}
      style={{
        fontSize: "9.5px",
        fontWeight: 700,
        color: "#fff",
        background: color,
        borderRadius: "4px",
        padding: "1px 5px",
        letterSpacing: "0.3px",
        flexShrink: 0,
      }}
    >
      {p}
    </span>
  );
}

/**
 * CVSS + Exploit-Value scoring card. Renders only when at least one score is
 * present; legacy findings without CVSS/EV show nothing (no empty card).
 */
function CvssEvCard({ finding }: { finding: FindingMeta }) {
  const hasCvss = finding.cvss_score != null || !!finding.cvss_vector;
  const hasEv = finding.ev_score != null || !!finding.ev_vector || !!finding.ev_priority;
  if (!hasCvss && !hasEv) return null;

  return (
    <div
      data-testid="finding-cvss-ev-card"
      style={{
        border: "1px solid var(--border)",
        borderRadius: "8px",
        padding: "10px 12px",
        marginBottom: "14px",
        background: "var(--bg-page)",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      {hasCvss && (
        <div style={{ display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap", minWidth: 0 }}>
          <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-secondary)", width: "42px", flexShrink: 0 }}>CVSS</span>
          {finding.cvss_score != null && (
            <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)", flexShrink: 0 }}>
              {finding.cvss_score}
            </span>
          )}
          {finding.cvss_vector && (
            <code style={{ fontSize: "11px", color: "var(--text-primary)", fontFamily: "monospace", wordBreak: "break-all", whiteSpace: "normal", minWidth: 0 }}>
              {finding.cvss_vector}
            </code>
          )}
        </div>
      )}
      {hasEv && (
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-secondary)", width: "42px", flexShrink: 0 }}>EV</span>
          {finding.ev_vector && (
            <code style={{ fontSize: "11px", color: "var(--text-primary)", fontFamily: "monospace", wordBreak: "break-all" }}>
              {finding.ev_vector}
            </code>
          )}
          {finding.ev_priority && <EvPriorityBadge priority={finding.ev_priority} />}
          {finding.ev_score != null && (
            <span style={{ marginLeft: finding.ev_priority ? "4px" : "auto", fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>
              {finding.ev_score}
            </span>
          )}
        </div>
      )}
      {finding.ev_rationale && (
        <div
          data-testid="finding-ev-rationale"
          style={{
            fontSize: "11.5px",
            color: "var(--text-secondary)",
            whiteSpace: "pre-wrap",
            lineHeight: 1.5,
            borderTop: "1px solid var(--divider)",
            paddingTop: "8px",
          }}
        >
          {finding.ev_rationale}
        </div>
      )}
    </div>
  );
}

function FindingRow({
  finding: f,
  selected,
  reviewFilter,
  batchMode,
  batchChecked,
  onBatchToggle,
  onClick,
}: {
  finding: FindingMeta;
  selected: boolean;
  reviewFilter: string;
  batchMode?: boolean;
  batchChecked?: boolean;
  onBatchToggle?: () => void;
  onClick: () => void;
}) {
  const sev = (f.severity ?? "info").toLowerCase();
  const isRisk = f.item_type === "risk" || f.finding_class === "risk";
  return (
    <div
      data-testid="finding-row"
      data-finding-id={f.id}
      data-finding-class={isRisk ? "risk" : "vulnerability"}
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
        {batchMode && (
          <div
            onClick={(e) => { e.stopPropagation(); onBatchToggle?.(); }}
            style={{
              width: 16, height: 16, borderRadius: 3, flexShrink: 0, marginTop: 1,
              border: `1.5px solid ${batchChecked ? "var(--brand)" : "var(--border)"}`,
              background: batchChecked ? "var(--brand)" : "transparent",
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
            }}
          >
            {batchChecked && <span style={{ color: "#fff", fontSize: 10, fontWeight: 700 }}>✓</span>}
          </div>
        )}
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
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: isRisk ? "var(--text-secondary)" : "var(--text-primary)",
                opacity: isRisk ? 0.6 : 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
                minWidth: 0,
              }}
            >
              {f.title ?? f.vuln_type_full ?? f.finding_key}
            </span>
            {isRisk && (
              <span
                data-testid="finding-risk-badge"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "3px",
                  fontSize: "9.5px",
                  fontWeight: 700,
                  color: "var(--text-secondary)",
                  background: "var(--bg-page)",
                  border: "1px solid var(--border)",
                  borderRadius: "4px",
                  padding: "1px 5px",
                  letterSpacing: "0.3px",
                  flexShrink: 0,
                }}
              >
                <Icon name="shield" size={10} />
                {i18n.t("findings.itemType.risk")}
              </span>
            )}
            {f.ev_priority && <EvPriorityBadge priority={f.ev_priority} />}
            {f.review_status && (f.review_status !== "pending" || reviewFilter !== "all") && (
              <ReviewStatusBadge status={f.review_status} />
            )}
          </div>
          <div
            style={{
              fontSize: "11px",
              color: "var(--text-secondary)",
              opacity: isRisk ? 0.6 : 1,
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

function EmptyState({
  icon,
  text,
}: {
  icon: "shield" | "chevron-left" | "check";
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
  dynamicEnabled = false,
  onViewCode,
}: {
  taskId: string;
  finding: FindingMeta;
  detail: FindingDetailData | undefined;
  loading: boolean;
  error: Error | null;
  dynamicEnabled?: boolean;
  /** Switch to the code tab within the same page (two-column layout). */
  onViewCode?: (target?: CodeTarget) => void;
}) {
  const navigate = useNavigate();
  const sev = (finding.severity ?? "info").toLowerCase();
  const sevColor = SEV_COLORS[sev] ?? SEV_COLORS.info;
  const isRisk = finding.item_type === "risk" || finding.finding_class === "risk";

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
  const primaryAnchor = anchors[0] ?? fallbackAnchor;
  const dataflow = normalizeDataflow(code.dataflow);
  const strFromField = (obj: Record<string, unknown>, ...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.length > 0) return v;
      if (typeof v === "number") return String(v);
    }
    return undefined;
  };
  const viewSource = (anchor: FindingAnchor | null | undefined) => {
    const path = anchor?.file_path ?? finding.primary_file;
    if (!path) return;
    const line = typeof anchor?.line === "number" ? anchor.line : finding.primary_line ?? null;
    if (onViewCode) {
      onViewCode({ path: normalizePath(path), line });
    } else {
      const params = new URLSearchParams();
      params.set("file", normalizePath(path));
      if (line) params.set("line", String(line));
      navigate(`/tasks/${taskId}/workspace?${params.toString()}`);
    }
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
          {finding.title ?? finding.vuln_type_full ?? finding.finding_key}
        </span>
        <span
          data-testid={isRisk ? "finding-detail-risk-badge" : "finding-detail-vuln-badge"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "3px",
            padding: "1px 5px",
            borderRadius: "4px",
            border: isRisk ? "1px solid var(--border)" : "1px solid rgba(220,38,38,.35)",
            background: isRisk ? "var(--bg-page)" : "var(--bg-error)",
            color: isRisk ? "var(--text-secondary)" : "var(--brand)",
            fontSize: "9.5px",
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {isRisk ? <Icon name="shield" size={10} /> : null}
          {i18n.t(isRisk ? "finding.riskBadge" : "finding.vulnBadge")}
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
        {primaryAnchor?.file_path ? (
          <button
            type="button"
            data-testid="finding-view-in-code"
            title={i18n.t("findings.viewInCode")}
            onClick={() => viewSource(primaryAnchor)}
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

      {/* Review status section */}
      <FindingReviewSection taskId={taskId} finding={finding} />

      {/* Stage summary rail (static / POC / impact) — shown immediately below
          review, matching the confirmed prototype's above-the-fold placement. */}
      <FindingStageRail finding={finding} dynamicEnabled={dynamicEnabled} />

      {/* CVSS / Exploit-Value scoring card (VulnForge) */}
      <div data-testid="finding-card-static" style={{ scrollMarginTop: "12px" }} />
      <CvssEvCard finding={finding} />

      <AnchorSection anchors={anchors} onViewCode={viewSource} />

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
          value={strFromField(metadata, "vuln_type_full_name", "vuln_type") ?? finding.vuln_type_full ?? finding.vuln_type ?? undefined}
        />
        <MetaField label={i18n.t("findings.field.cwe")} value={strFromField(metadata, "cwe") ?? finding.cwe ?? undefined} />
        <MetaField label={i18n.t("findings.field.function")} value={primaryAnchor?.function ?? finding.function_name ?? undefined} mono />
        <MetaField label={i18n.t("findings.field.language")} value={strFromField(metadata, "language")} />
        <MetaField
          label={i18n.t("findings.field.permission")}
          value={strFromField(metadata, "permission_requirement")}
        />
        <MetaField label={i18n.t("findings.field.source")} value={strFromField(metadata, "source")} mono />
        <MetaField label={i18n.t("findings.field.sink")} value={strFromField(metadata, "sink")} mono />
      </div>

      <FlexibleSection
        testid="finding-section-description"
        title={i18n.t("findings.section.description")}
        raw={description}
        defaultOpen
        structuredFields={[
          [i18n.t("findings.field.background"), "background"],
          [i18n.t("findings.field.detail"), "detailed_description"],
          [i18n.t("findings.field.payload"), "attack_payload_description"],
          [i18n.t("findings.section.attack"), "attack_description"],
          [i18n.t("findings.field.entryPoint"), "entry_point"],
          [i18n.t("findings.field.taintSource"), "taint_source"],
          [i18n.t("findings.field.trigger"), "trigger_condition"],
        ]}
      />

      <DataflowSection dataflow={dataflow} />

      <FlexibleSection
        testid="finding-section-code"
        title={i18n.t("findings.section.code")}
        raw={code}
        defaultOpen
        codeTone="bad"
        structuredCodePairs={[
          [i18n.t("findings.field.vulnerableCode"), "vulnerable_code", "bad"],
          [i18n.t("findings.field.fixPatch"), "fix_patch", "good"],
          [i18n.t("findings.field.fixCode"), "fix_code", "good"],
        ]}
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

      {/* Dynamic capability three cards (static / POC / impact assessment) */}
      <FindingDynamicCards taskId={taskId} finding={finding} dynamicEnabled={dynamicEnabled} />
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
    .filter((anchor) => !!anchor.file_path);
}

function normalizeDataflow(value: unknown): DataflowStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => asRecord(raw))
    .map((raw) => ({
      step: typeof raw.step === "number" || typeof raw.step === "string" ? raw.step : undefined,
      location: typeof raw.location === "string" ? raw.location : undefined,
      description: typeof raw.description === "string" ? raw.description : undefined,
    }))
    .filter((step) => step.step != null || step.location || step.description);
}

function AnchorSection({
  anchors,
  onViewCode,
}: {
  anchors: FindingAnchor[];
  onViewCode: (anchor: FindingAnchor | null | undefined) => void;
}) {
  if (anchors.length <= 1) return null;

  return (
    <div data-testid="finding-anchors" style={{ marginBottom: "14px" }}>
      <div style={{ ...SUBLABEL_STYLE, marginBottom: "6px" }}>
        {i18n.t("findings.anchors.title")} ({anchors.length})
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: "8px", overflow: "hidden", background: "var(--bg-card)" }}>
        {anchors.map((anchor, index) => {
          const line = anchor.line ? `:${anchor.line}` : "";
          const isPrimary = index === 0;
          return (
            <button
              key={`${anchor.file_path}:${anchor.line ?? ""}:${index}`}
              type="button"
              data-testid="finding-anchor-row"
              data-primary={isPrimary || undefined}
              onClick={() => onViewCode(anchor)}
              style={{
                width: "100%",
                minHeight: "30px",
                padding: "6px 10px",
                border: "none",
                borderTop: index === 0 ? "none" : "1px solid var(--divider)",
                borderLeft: `2px solid ${isPrimary ? "var(--brand)" : "transparent"}`,
                background: "transparent",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "inherit",
                color: "var(--text-primary)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                const arrow = e.currentTarget.querySelector("[data-anchor-arrow]") as HTMLSpanElement | null;
                if (arrow) arrow.style.color = "var(--brand)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                const arrow = e.currentTarget.querySelector("[data-anchor-arrow]") as HTMLSpanElement | null;
                if (arrow) arrow.style.color = "var(--text-secondary)";
              }}
            >
              <Icon name="code" size={12} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
              <span style={{ ...VALUE_STYLE, fontFamily: "'SF Mono', Menlo, Consolas, monospace", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {normalizePath(anchor.file_path ?? "")}{line}
                {anchor.function && <span style={{ color: "var(--text-secondary)", fontFamily: "inherit" }}> · {anchor.function}</span>}
              </span>
              <span data-anchor-arrow style={{ color: "var(--text-secondary)", fontSize: "13px", flexShrink: 0 }}>→</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DataflowSection({ dataflow }: { dataflow: DataflowStep[] }) {
  if (dataflow.length === 0) return null;
  return (
    <Section testid="finding-section-dataflow" title={i18n.t("findings.section.dataFlow")} defaultOpen>
      <ol style={{ margin: 0, paddingLeft: "20px", display: "flex", flexDirection: "column", gap: "10px" }}>
        {dataflow.map((step, index) => (
          <li key={`${step.step ?? index}:${step.location ?? ""}`} style={{ ...VALUE_STYLE, paddingLeft: "2px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                {i18n.t("findings.taintStep").replace("{n}", String(step.step ?? index + 1))}
              </span>
              {step.location && (
                <code style={{ fontSize: "11.5px", color: "var(--text-primary)", fontFamily: "'SF Mono', Menlo, Consolas, monospace", wordBreak: "break-all" }}>
                  {step.location}
                </code>
              )}
            </div>
            {step.description && <p style={{ ...PARA_STYLE, marginTop: "4px" }}>{step.description}</p>}
          </li>
        ))}
      </ol>
    </Section>
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

function isUnifiedDiff(content: string): boolean {
  return /^diff --git /m.test(content) || /^@@\s+[-+]/m.test(content) || (/^---\s+/m.test(content) && /^\+\+\+\s+/m.test(content));
}

function DiffPatch({ content }: { content: string }) {
  return (
    <div
      data-testid="finding-diff-patch"
      style={{ margin: "6px 0 0", border: "1px solid var(--border)", borderRadius: "7px", overflow: "auto", maxHeight: "320px", background: "var(--code-bg)", fontFamily: "'SF Mono', Menlo, Consolas, monospace", fontSize: "11.5px", lineHeight: 1.55 }}
    >
      {content.split("\n").map((line, index) => {
        const added = line.startsWith("+") && !line.startsWith("+++");
        const removed = line.startsWith("-") && !line.startsWith("---");
        const hunk = line.startsWith("@@");
        const header = line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++");
        return (
          <div
            key={index}
            style={{
              minHeight: "1.55em",
              padding: "0 10px",
              whiteSpace: "pre",
              background: added ? "rgba(22,163,74,0.12)" : removed ? "rgba(220,38,38,0.12)" : hunk ? "rgba(37,99,235,0.09)" : "transparent",
              color: added ? "#15803d" : removed ? "#b91c1c" : hunk ? "#1d4ed8" : header ? "var(--text-secondary)" : "var(--text-primary)",
              fontWeight: header || hunk ? 600 : 400,
            }}
          >
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

function CodeBlock({
  content,
  tone,
}: {
  content: string;
  tone: "bad" | "good" | "neutral";
}) {
  if (isUnifiedDiff(content)) return <DiffPatch content={content} />;

  const bg =
    tone === "bad"
      ? "var(--bg-error)"
      : tone === "good"
        ? "var(--bg-success)"
        : "var(--code-bg)";
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

/* -------------------------------------------------------------------------- */
/*  Finding Review Section (inside detail panel)                              */
/* -------------------------------------------------------------------------- */

function FindingReviewSection({ taskId, finding }: { taskId: string; finding: FindingMeta }) {
  const qc = useQueryClient();

  // Review events query
  const { data: eventsData } = useQuery({
    queryKey: ["finding-review-events", taskId, finding.finding_key],
    queryFn: () => api.findings.reviewEvents(taskId, finding.finding_key),
  });

  // Review mutation
  const reviewMutation = useMutation({
    mutationFn: (args: { status: FindingReviewStatus; note?: string }) =>
      api.findings.updateReview(taskId, finding.finding_key, {
        review_status: args.status,
        note: args.note,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["findings", taskId] });
      qc.invalidateQueries({ queryKey: ["finding-review-events", taskId, finding.finding_key] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  return (
    <div
      style={{
        paddingBottom: 12,
        marginBottom: 12,
        borderBottom: "1px solid var(--divider)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-secondary)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          marginBottom: 8,
        }}
      >
        {i18n.t("review.section.title")}
      </div>
      <ReviewStatusSelect
        value={finding.review_status ?? "pending"}
        onChange={(status, note) => reviewMutation.mutate({ status, note })}
        disabled={reviewMutation.isPending}
      />
      <ReviewHistoryTimeline events={eventsData?.events ?? []} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Batch Review Dropdown                                                     */
/* -------------------------------------------------------------------------- */

function BatchReviewDropdown({
  taskId,
  findingKeys,
  disabled,
  onDone,
}: {
  taskId: string;
  findingKeys: string[];
  disabled: boolean;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [noteTarget, setNoteTarget] = useState<FindingReviewStatus | null>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const bulkMut = useMutation({
    mutationFn: (args: { status: FindingReviewStatus; note?: string }) =>
      api.findings.bulkUpdateReview(taskId, {
        finding_keys: findingKeys,
        review_status: args.status,
        note: args.note,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["findings", taskId] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      setOpen(false);
      onDone();
    },
  });

  function handlePick(status: FindingReviewStatus) {
    if (status === "false_positive" || status === "ignored") {
      setNoteTarget(status);
      setOpen(false);
    } else {
      bulkMut.mutate({ status });
    }
  }

  const statuses: FindingReviewStatus[] = ["confirmed", "false_positive", "ignored", "pending"];

  return (
    <>
      <div ref={dropRef} style={{ position: "relative" }}>
        <button
          disabled={disabled || bulkMut.isPending}
          onClick={() => setOpen(!open)}
          style={{
            padding: "2px 8px",
            border: "1px solid var(--brand)",
            borderRadius: 4,
            background: "var(--brand)",
            color: "#fff",
            fontSize: 11,
            fontFamily: "inherit",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {i18n.t("review.action.batchMark")} ▾
        </button>
        {open && (
          <div style={{
            position: "absolute", top: "100%", right: 0, marginTop: 4, zIndex: 100,
            background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6,
            boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 120, overflow: "hidden",
          }}>
            {statuses.map(s => {
              const meta = REVIEW_STATUS_META[s];
              return (
                <div
                  key={s}
                  onClick={() => handlePick(s)}
                  style={{
                    padding: "6px 12px", cursor: "pointer", fontSize: 12,
                    display: "flex", alignItems: "center", gap: 6,
                    color: meta.color,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: meta.color }} />
                  {i18n.t(meta.labelKey)}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {noteTarget && (
        <ReviewNoteModal
          targetStatus={noteTarget}
          onConfirm={(note) => {
            bulkMut.mutate({ status: noteTarget, note });
            setNoteTarget(null);
          }}
          onCancel={() => setNoteTarget(null)}
        />
      )}
    </>
  );
}
