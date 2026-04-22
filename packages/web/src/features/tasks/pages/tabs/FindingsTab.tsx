import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  api,
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
  const byLeaf = new Map<string, { count: number; maxSev: string }>();
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
    const leaf = raw.split("/").pop() ?? raw;
    const leafSlot = byLeaf.get(leaf);
    if (leafSlot) {
      leafSlot.count += 1;
      leafSlot.maxSev = maxSeverity(leafSlot.maxSev, sev)!;
    } else {
      byLeaf.set(leaf, { count: 1, maxSev: sev });
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
        const hit = byPath.get(path) ?? byLeaf.get(node.name);
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

  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    null,
  );
  /** Active file filter. When set, left list shows only findings in this file. */
  const [fileFilter, setFileFilter] = useState<string | null>(null);
  /** Explicitly view a non-vuln file in right panel (not a finding). */
  const [nonVulnFile, setNonVulnFile] = useState<string | null>(null);
  const [treeCollapsed, setTreeCollapsed] = useState<Set<string>>(new Set());

  const [leftWidth, setLeftWidth] = useState(26); // percent
  const [midWidth, setMidWidth] = useState(22); // percent (of total)
  const [draggingLeft, setDraggingLeft] = useState(false);
  const [draggingMid, setDraggingMid] = useState(false);

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

  /* -------- Filtered findings (left panel) -------- */

  const filteredFindings = useMemo(() => {
    if (!fileFilter) return allFindings;
    return allFindings.filter(
      (f) => normalizePath(f.primary_file ?? "") === fileFilter,
    );
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

  /* -------- Splitters -------- */

  function startLeftDrag(e: React.MouseEvent) {
    e.preventDefault();
    setDraggingLeft(true);
    function onMove(mv: MouseEvent) {
      const c = document.querySelector<HTMLElement>(
        "[data-testid='findings-three-col']",
      );
      if (!c) return;
      const rect = c.getBoundingClientRect();
      const pct = ((mv.clientX - rect.left) / rect.width) * 100;
      // Keep left between 200px and 40%, and leave room for mid + right.
      const minPct = rect.width > 0 ? (200 / rect.width) * 100 : 16;
      const maxPct = 100 - midWidth - 20;
      setLeftWidth(Math.max(minPct, Math.min(maxPct, pct)));
    }
    function onUp() {
      setDraggingLeft(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function startMidDrag(e: React.MouseEvent) {
    e.preventDefault();
    setDraggingMid(true);
    function onMove(mv: MouseEvent) {
      const c = document.querySelector<HTMLElement>(
        "[data-testid='findings-three-col']",
      );
      if (!c) return;
      const rect = c.getBoundingClientRect();
      // midWidth extends from left edge to splitter; its left boundary
      // is at leftWidth% of the container.
      const pctFromContainer = ((mv.clientX - rect.left) / rect.width) * 100;
      const requestedMid = pctFromContainer - leftWidth;
      const minMid = rect.width > 0 ? (180 / rect.width) * 100 : 14;
      const maxMid = 100 - leftWidth - 20;
      setMidWidth(Math.max(minMid, Math.min(maxMid, requestedMid)));
    }
    function onUp() {
      setDraggingMid(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  /* -------- Render -------- */

  return (
    <div data-testid="task-detail-panel-findings" style={{ position: "relative" }}>
      {/* Filter bar */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          marginBottom: "16px",
          alignItems: "center",
        }}
      >
        {["all", "critical", "high", "medium", "low", "info"].map((s) => (
          <button
            key={s}
            data-testid={`findings-filter-${s}`}
            onClick={() => setSeverityFilter(s)}
            style={{
              padding: "4px 10px",
              border: `1px solid ${
                severityFilter === s && s !== "all"
                  ? SEV_COLORS[s]
                  : severityFilter === s
                    ? "var(--brand)"
                    : "var(--border)"
              }`,
              borderRadius: "6px",
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
              fontSize: "12px",
              fontWeight: 500,
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {s === "all"
              ? i18n.t("findings.filterAll")
              : s === "critical"
                ? "Critical"
                : i18n.t(
                    `findings.sev${s.charAt(0).toUpperCase()}${s.slice(1)}`,
                  )}
          </button>
        ))}
        <span
          style={{
            marginLeft: "auto",
            fontSize: "12px",
            color: "var(--text-secondary)",
          }}
        >
          {fileFilter
            ? i18n
                .t("findings.filteredBy")
                .replace("{n}", String(filteredFindings.length))
                .replace("{file}", fileFilter.split("/").pop() ?? fileFilter)
            : `${allFindings.length} ${i18n.t("findings.count")}`}
        </span>
        {fileFilter && (
          <button
            data-testid="findings-clear-filter"
            onClick={clearFilter}
            style={{
              border: "none",
              background: "transparent",
              color: "var(--brand)",
              fontSize: "12px",
              cursor: "pointer",
              padding: "0 4px",
            }}
          >
            {i18n.t("findings.clearFilter")}
          </button>
        )}
      </div>

      {/* Three-column container */}
      <div
        data-testid="findings-three-col"
        style={{
          display: "flex",
          height: "calc(100vh - 360px)",
          minHeight: "420px",
          border: "1px solid var(--border)",
          borderRadius: "10px",
          overflow: "hidden",
          background: "var(--bg-card)",
        }}
      >
        {/* ================================================================ */}
        {/*  Left: findings list                                             */}
        {/* ================================================================ */}
        <div
          data-testid="findings-list-panel"
          style={{
            width: `${leftWidth}%`,
            flexShrink: 0,
            overflow: "auto",
            borderRight: "1px solid var(--border)",
            background: "var(--bg-card)",
            minWidth: 0,
          }}
        >
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
                onClick={() => handlePickFinding(f)}
              />
            ))
          )}
        </div>

        {/* Splitter 1 */}
        <div
          data-testid="findings-splitter-1"
          onMouseDown={startLeftDrag}
          onDoubleClick={() => setLeftWidth(26)}
          style={{
            width: "4px",
            flexShrink: 0,
            background: draggingLeft ? "var(--brand)" : "var(--border)",
            cursor: "col-resize",
            transition: draggingLeft ? "none" : "background 0.15s",
          }}
          title="Double-click to reset"
        />

        {/* ================================================================ */}
        {/*  Middle: file tree                                               */}
        {/* ================================================================ */}
        <div
          data-testid="findings-file-tree"
          style={{
            width: `${midWidth}%`,
            flexShrink: 0,
            overflow: "hidden",
            borderRight: "1px solid var(--border)",
            background: "var(--bg-page)",
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <div
            style={{
              padding: "10px 14px",
              borderBottom: "1px solid var(--divider)",
              fontSize: "13px",
              fontWeight: 600,
              color: "var(--text-primary)",
              background: "var(--bg-card)",
            }}
          >
            {i18n.t("findings.files")}
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "6px 0" }}>
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
        </div>

        {/* Splitter 2 */}
        <div
          data-testid="findings-splitter-2"
          onMouseDown={startMidDrag}
          onDoubleClick={() => setMidWidth(22)}
          style={{
            width: "4px",
            flexShrink: 0,
            background: draggingMid ? "var(--brand)" : "var(--border)",
            cursor: "col-resize",
            transition: draggingMid ? "none" : "background 0.15s",
          }}
          title="Double-click to reset"
        />

        {/* ================================================================ */}
        {/*  Right: code viewer                                              */}
        {/* ================================================================ */}
        <div
          data-testid="findings-code-viewer"
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            background: "var(--code-bg)",
          }}
        >
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
        padding: "12px 16px",
        borderBottom: "1px solid var(--divider)",
        cursor: "pointer",
        background: selected ? "var(--bg-page)" : "transparent",
        borderLeft: selected
          ? "3px solid var(--brand)"
          : "3px solid transparent",
        transition: "all 0.1s",
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
