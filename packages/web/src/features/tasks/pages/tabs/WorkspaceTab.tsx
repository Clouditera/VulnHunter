import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type Task,
  type WorkspaceFile,
  type WorkspaceTreeNode,
  type FindingMeta,
  type AuditProgressNode,
  type CoverageSummary,
} from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";
import { Icon } from "../../../../shared/components/Icon.js";
import { Splitter, useResizableWidth } from "../../../../shared/components/Splitter.js";

/* -------------------------------------------------------------------------- */
/*  Audit progress (审计进展) — green-ramp depth overlay on the code tree        */
/* -------------------------------------------------------------------------- */

// 4-band green ramp. Low ≠ bad → no red (red = vulnerability). 0 = grey.
const AUDIT_BANDS = [
  { min: 0.7, color: "var(--audit-high)" }, // ≥70%
  { min: 0.3, color: "var(--audit-mid)" }, // 30–70%
  { min: 0.001, color: "var(--audit-low)" }, // 1–30%
  { min: 0, color: "var(--audit-none)" }, // 0%
] as const;

function auditColor(ratio: number): string {
  return (AUDIT_BANDS.find((b) => ratio >= b.min) ?? AUDIT_BANDS[3]).color;
}

/**
 * Normalize a path for audit-coverage join. Coverage JSON keys are relative to
 * the target root (`src/openvpn/ssl.c`); tree node paths may carry a
 * `/workspace/` prefix or `./` — strip both sides to the same shape so the
 * join lands (the #1 pitfall flagged by architect: mismatch → whole tree shows
 * “not audited”).
 */
function normAuditPath(p: string): string {
  return p
    .replace(/^\/+workspace\/+/, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

interface AuditEntry {
  coverage: number;
  read_lines: number;
  total_lines: number;
}

/** Tree-row badge: 36px track + fill + % (or — at 0%). Right of the vuln dot. */
function AuditBadge({ entry }: { entry: AuditEntry }) {
  const pct = Math.round(entry.coverage * 100);
  return (
    <span
      data-testid="workspace-audit-badge"
      title={
        pct > 0
          ? i18n
              .t("audit.rowTitle")
              .replace("{read}", entry.read_lines.toLocaleString())
              .replace("{total}", entry.total_lines.toLocaleString())
          : i18n.t("audit.notAudited")
      }
      style={{ display: "flex", alignItems: "center", gap: "5px", flexShrink: 0 }}
    >
      <span style={{ width: "36px", height: "4px", borderRadius: "2px", background: "var(--bg-page)", overflow: "hidden" }}>
        <span style={{ display: "block", width: `${pct}%`, height: "100%", background: auditColor(entry.coverage), transition: "width .3s, background .3s" }} />
      </span>
      <span style={{ fontSize: "11px", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums", width: "28px", textAlign: "right" }}>
        {pct > 0 ? `${pct}%` : "—"}
      </span>
    </span>
  );
}

/** Top total progress bar (under the tree search box). */
function AuditProgressBar({ s }: { s: CoverageSummary }) {
  const pct = (s.coverage * 100).toFixed(1);
  return (
    <div data-testid="workspace-audit-total" style={{ padding: "8px 12px", borderBottom: "1px solid var(--divider)", background: "var(--bg-card)" }}>
      <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "6px" }}>
        ⏳ {i18n.t("audit.title")} {pct}% ·{" "}
        {i18n.t("audit.lines").replace("{r}", s.read_lines.toLocaleString()).replace("{t}", s.total_lines.toLocaleString())} · {s.covered_files}/{s.files}{" "}
        {i18n.t("audit.files")}
      </div>
      <div style={{ height: "6px", borderRadius: "3px", background: "var(--bg-page)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: auditColor(s.coverage), transition: "width .3s" }} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

interface FlatNode {
  name: string;
  path: string;
  depth: number;
  isDir: boolean;
  hasVuln: boolean;
  vulnCount: number;
  /** Collapsed state — directories only. */
  collapsed: boolean;
}

/**
 * Flatten the backend tree into a rendering-ready list honouring:
 *  - collapsed state for directories
 *  - vuln markers derived from the findings list (primary_file path match)
 *  - search filter on leaf names (directories are auto-expanded when a
 *    descendant matches, and leaves that don't match are filtered out)
 */
function flattenTree(
  tree: WorkspaceTreeNode[],
  findings: FindingMeta[],
  collapsed: Set<string>,
  query: string,
): FlatNode[] {
  // Map from workspace-path → vuln count. We normalize:
  //   /workspace/src/foo/bar.c  → src/foo/bar.c  → bar.c last-segment match
  const vulnCountsByPath = new Map<string, number>();
  // Collect all finding paths for suffix matching
  const findingPaths: string[] = [];
  for (const f of findings) {
    const raw = (f.primary_file ?? "").replace(/^\/+workspace\/+/, "").replace(/^\/+/, "");
    if (!raw) continue;
    vulnCountsByPath.set(raw, (vulnCountsByPath.get(raw) ?? 0) + 1);
    findingPaths.push(raw);
  }

  const q = query.trim().toLowerCase();
  const out: FlatNode[] = [];

  function walk(nodes: WorkspaceTreeNode[], depth: number, parentPath: string): boolean {
    let anyMatch = false;
    for (const node of nodes) {
      const path = parentPath ? `${parentPath}/${node.name}` : node.name;
      // Treat as directory in any of these cases (B9 backend quirk):
      //  - explicit `type: "dir"`
      //  - `children` array present at all, even empty (backend currently
      //    labels dirs as `type: "file"` but emits `children: []`)
      //  - name contains no file extension (weaker heuristic fallback)
      const isDir =
        node.type === "dir" ||
        Array.isArray(node.children) ||
        (!node.type && !/\.[a-zA-Z0-9]{1,6}$/.test(node.name));

      if (isDir) {
        // Recurse first to know whether any descendant matches the query.
        const collector: FlatNode[] = [];
        const saved = out.length;
        // Temporarily swap out to a sub-array; easier to just call
        // recursively with a local output and splice in.
        const subHits = walkInto(
          node.children ?? [],
          depth + 1,
          path,
          collapsed,
          q,
          findings,
          collector,
        );
        const dirMatchesByName = !q || node.name.toLowerCase().includes(q);
        const shouldShow = !q || subHits > 0 || dirMatchesByName;
        if (!shouldShow) continue;
        const isCollapsed = collapsed.has(path) && !q;
        const vulnCount = collector.reduce((a, b) => a + b.vulnCount, 0);
        out.push({
          name: node.name,
          path,
          depth,
          isDir: true,
          hasVuln: vulnCount > 0,
          vulnCount,
          collapsed: isCollapsed,
        });
        // If not collapsed (or search is active — force expand), emit children.
        if (!isCollapsed) {
          // Re-run visibly with collector's already-computed results.
          out.push(...collector);
        }
        void saved;
        anyMatch = anyMatch || subHits > 0 || dirMatchesByName;
      } else {
        const matches = !q || node.name.toLowerCase().includes(q);
        if (!matches) continue;
        const vulnByPath = vulnCountsByPath.get(path);
        const vulnCount =
          vulnByPath !== undefined ? vulnByPath : (findingPaths.some((fp) => path.endsWith("/" + fp) || fp.endsWith("/" + path)) ? 1 : 0);
        out.push({
          name: node.name,
          path,
          depth,
          isDir: false,
          hasVuln: vulnCount > 0,
          vulnCount,
          collapsed: false,
        });
        anyMatch = true;
      }
    }
    return anyMatch;
  }

  function walkInto(
    nodes: WorkspaceTreeNode[],
    depth: number,
    parentPath: string,
    collapsed: Set<string>,
    q: string,
    findings: FindingMeta[],
    target: FlatNode[],
  ): number {
    // Reuse the outer logic but push into a local target.
    const ownOut = out;
    // Swap the shared `out` by using a shadow: collect via shim.
    let hits = 0;
    for (const node of nodes) {
      const path = parentPath ? `${parentPath}/${node.name}` : node.name;
      const isDir =
        node.type === "dir" ||
        Array.isArray(node.children) ||
        (!node.type && !/\.[a-zA-Z0-9]{1,6}$/.test(node.name));
      if (isDir) {
        const sub: FlatNode[] = [];
        const subHits = walkInto(
          node.children ?? [],
          depth + 1,
          path,
          collapsed,
          q,
          findings,
          sub,
        );
        const dirMatchesByName = !q || node.name.toLowerCase().includes(q);
        const shouldShow = !q || subHits > 0 || dirMatchesByName;
        if (!shouldShow) continue;
        const isCollapsed = collapsed.has(path) && !q;
        const vulnCount = sub.reduce((a, b) => a + b.vulnCount, 0);
        target.push({
          name: node.name,
          path,
          depth,
          isDir: true,
          hasVuln: vulnCount > 0,
          vulnCount,
          collapsed: isCollapsed,
        });
        if (!isCollapsed) target.push(...sub);
        hits += subHits;
        if (dirMatchesByName) hits += 1;
      } else {
        const matches = !q || node.name.toLowerCase().includes(q);
        if (!matches) continue;
        const vulnByPath = vulnCountsByPath.get(path);
        const vulnCount =
          vulnByPath !== undefined ? vulnByPath : (findingPaths.some((fp) => path.endsWith("/" + fp) || fp.endsWith("/" + path)) ? 1 : 0);
        target.push({
          name: node.name,
          path,
          depth,
          isDir: false,
          hasVuln: vulnCount > 0,
          vulnCount,
          collapsed: false,
        });
        hits += 1;
      }
    }
    void ownOut;
    return hits;
  }

  walk(tree, 0, "");
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function WorkspaceTab() {
  const { task } = useOutletContext<{ task: Task }>();
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);

  // Re-init collapse on task switch.
  useEffect(() => setCollapseInitDone(false), [task.id]);

  // Deep-link support: Findings "View in Code" navigates here with
  // ?file=<path>&line=<n> search params. Read them once on mount so the
  // code viewer opens the right file at the right line.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkFile = searchParams.get("file");
  const deepLinkLine = searchParams.get("line");

  const [selectedPath, setSelectedPath] = useState<string | null>(
    deepLinkFile ?? null,
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** First-load init flag so we collapse-all once but don't undo user edits. */
  const [collapseInitDone, setCollapseInitDone] = useState(false);
  const [query, setQuery] = useState("");
  // Group B Tabs (code-oriented right panel): resizable left width,
  // defaulting to 300px (matches POC Tab).
  const [LEFT_PANEL_WIDTH, setLeftPanelWidth] = useResizableWidth("workspace-left-width", 300, { min: 240, max: 700 });
  const splitContainerRef = useRef<HTMLDivElement>(null);

  // Collect all directory paths from the tree once it loads, then collapse
  // them by default. Users see only the root level on entry and click to
  // drill in (vscode-style). Search auto-expands matching dirs in flatten,
  // so this doesn't break find-in-tree UX. Runs once per task.
  // (declared below; the actual effect runs after `treeData` is fetched)

  const { data: treeData, isLoading: treeLoading, error: treeError } = useQuery({
    queryKey: ["workspace-tree", task.id],
    queryFn: () => api.tasks.workspaceTree(task.id),
    staleTime: 60_000,
  });

  // Default-collapse: on first tree load (per task), put every directory
  // into `collapsed` so only the root level is visible. User clicks to drill
  // in (vscode-style). Doesn't run again unless the task changes — user
  // expand/collapse decisions persist within the session.
  useEffect(() => {
    if (collapseInitDone) return;
    const tree = treeData?.tree;
    if (!tree || tree.length === 0) return;
    const allDirs = new Set<string>();
    const walk = (nodes: typeof tree, prefix: string) => {
      for (const n of nodes) {
        const path = prefix ? `${prefix}/${n.name}` : n.name;
        const isDir =
          n.type === "dir" ||
          Array.isArray(n.children) ||
          (!n.type && !/\.[a-zA-Z0-9]{1,6}$/.test(n.name));
        if (isDir) {
          allDirs.add(path);
          if (n.children?.length) walk(n.children, path);
        }
      }
    };
    walk(tree, "");
    setCollapsed(allDirs);
    setCollapseInitDone(true);
  }, [treeData, collapseInitDone]);

  const { data: findingsData } = useQuery({
    queryKey: ["findings", task.id],
    queryFn: () => api.findings.list(task.id),
    staleTime: 30_000,
  });

  // Audit progress (审计进展): full per-file/dir coverage map. Running tasks
  // refetch every 5min (fish spec) so the tree deepens live; terminal tasks
  // fetch once. Backend reads bind-mount live for running.
  const isRunning = task.state === "running" || task.state === "paused";
  const { data: auditData } = useQuery({
    queryKey: ["audit-progress", task.id],
    queryFn: () => api.tasks.auditProgress(task.id),
    staleTime: 60_000,
    refetchInterval: isRunning ? 300_000 : false,
  });

  // path(normalized) → audit entry, for both files and directories. Directory
  // aggregates come straight from the engine JSON (do NOT sum client-side).
  const auditByPath = useMemo(() => {
    const m = new Map<string, AuditEntry>();
    const add = (nodes: AuditProgressNode[] | undefined) => {
      for (const n of nodes ?? []) {
        m.set(normAuditPath(n.path), {
          coverage: n.coverage,
          read_lines: n.read_lines,
          total_lines: n.total_lines,
        });
      }
    };
    add(auditData?.directories);
    add(auditData?.files);
    return m;
  }, [auditData]);

  // When we arrive via deep-link (?file=...&line=...), consume and clear
  // the params so a manual tab switch doesn't replay them. Also expand
  // any collapsed parent directories so the file is visible in the tree.
  const deepLineNum = deepLinkLine ? Number(deepLinkLine) : undefined;
  useEffect(() => {
    if (!deepLinkFile) return;
    // Clear query string without adding a history entry.
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkFile]);

  const {
    data: fileData,
    isLoading: fileLoading,
    error: fileError,
  } = useQuery<WorkspaceFile>({
    queryKey: ["workspace-file", task.id, selectedPath],
    queryFn: () =>
      api.tasks.workspaceFile(task.id, selectedPath!, deepLineNum),
    enabled: !!selectedPath,
    staleTime: 5 * 60_000,
  });

  const flat = useMemo(
    () =>
      flattenTree(
        treeData?.tree ?? [],
        findingsData?.findings ?? [],
        collapsed,
        query,
      ),
    [treeData, findingsData, collapsed, query],
  );

  function toggleDir(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }


  const vulnLineSet = useMemo(() => {
    const set = new Set<number>();
    (fileData?.vuln_decorations ?? []).forEach((d) => set.add(d.line));
    // If backend hasn't populated vuln_decorations yet, fall back to the
    // current findings list and match by filename.
    if (set.size === 0 && findingsData?.findings && selectedPath) {
      const leaf = selectedPath.split("/").pop() ?? "";
      for (const f of findingsData.findings) {
        const fp = (f.primary_file ?? "").replace(/^\/+workspace\/+/, "");
        const fpLeaf = fp.split("/").pop() ?? "";
        if ((fp && selectedPath.endsWith(fp)) || (!!leaf && leaf === fpLeaf)) {
          if (f.primary_line) set.add(f.primary_line);
        }
      }
    }
    return set;
  }, [fileData, findingsData, selectedPath]);

  return (
    <div
      data-testid="task-detail-panel-workspace"
      style={{ position: "relative", display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%" }}
    >
      <div
        ref={splitContainerRef}
        data-testid="workspace-container"
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
        {/* ================================================================= */}
        {/*  Left: file tree                                                  */}
        {/* ================================================================= */}
        <div
          data-testid="workspace-tree"
          style={{
            width: `${LEFT_PANEL_WIDTH}px`,
            flexShrink: 0,
            background: "var(--bg-page)",
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          {/* Search bar */}
          <div
            style={{
              padding: "10px 12px",
              borderBottom: "1px solid var(--divider)",
              background: "var(--bg-card)",
            }}
          >
            <div style={{ position: "relative" }}>
              <Icon
                name="search"
                size={13}
                style={{
                  position: "absolute",
                  left: "8px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--text-secondary)",
                  pointerEvents: "none",
                }}
              />
              <input
                data-testid="workspace-tree-search"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={i18n.t("workspace.search")}
                style={{
                  width: "100%",
                  height: "28px",
                  padding: "0 8px 0 28px",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  fontSize: "12px",
                  color: "var(--text-primary)",
                  background: "var(--bg-page)",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
          </div>

          {/* Total audit-progress bar (审计进展) */}
          {auditData?.summary ? <AuditProgressBar s={auditData.summary} /> : null}

          {/* Tree list */}
          <div style={{ flex: 1, overflow: "auto", padding: "6px 0" }}>
            {treeLoading ? (
              <div style={TREE_MSG}>{i18n.t("workspace.loading.tree")}</div>
            ) : treeError || flat.length === 0 ? (
              // Pick the most useful empty-state message based on task state.
              // Previously every error showed a red ERR_NOT_FOUND-ish line
              // which fish (B3) found scary; now we explain WHY there's no
              // code instead of treating it as an error.
              <div
                data-testid="workspace-empty-state"
                style={{
                  ...TREE_MSG,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "8px",
                  padding: "40px 16px",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: "13px", fontWeight: 500 }}>
                  {task.state === "running" || task.state === "queued"
                    ? i18n.t("workspace.empty.running")
                    : task.state === "cancelled"
                      ? i18n.t("workspace.empty.cancelled")
                      : task.state === "failed"
                        ? i18n.t("workspace.empty.failed")
                        : i18n.t("workspace.empty")}
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--text-secondary)",
                    opacity: 0.85,
                  }}
                >
                  {i18n.t("workspace.empty.hint")}
                </div>
              </div>
            ) : (
              flat.map((n) => (
                <TreeRow
                  key={n.path}
                  node={n}
                  selected={selectedPath === n.path}
                  audit={auditByPath.get(normAuditPath(n.path))}
                  onClick={() => {
                    if (n.isDir) toggleDir(n.path);
                    else setSelectedPath(n.path);
                  }}
                />
              ))
            )}
          </div>
        </div>


        {/* Resizable splitter */}
        <Splitter
          value={LEFT_PANEL_WIDTH}
          onResize={setLeftPanelWidth}
          min={240}
          max={700}
          containerRef={splitContainerRef}
        />

        {/* ================================================================= */}
        {/*  Right: code viewer                                               */}
        {/* ================================================================= */}
        <div
          data-testid="workspace-code"
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            background: "var(--code-bg)",
          }}
        >
          {selectedPath ? (
            <CodeViewer
              path={selectedPath}
              file={fileData}
              loading={fileLoading}
              error={fileError as Error | null}
              vulnLines={vulnLineSet}
            />
          ) : (
            <EmptyCodePlaceholder />
          )}
        </div>
      </div>
    </div>
  );
}

const TREE_MSG: React.CSSProperties = {
  padding: "16px 14px",
  color: "var(--text-secondary)",
  fontSize: "12px",
};

/* -------------------------------------------------------------------------- */
/*  Tree row                                                                  */
/* -------------------------------------------------------------------------- */

function TreeRow({
  node,
  selected,
  audit,
  onClick,
}: {
  node: FlatNode;
  selected: boolean;
  audit?: AuditEntry;
  onClick: () => void;
}) {
  // B — heat coloring: left 2px bar tinted by audit depth (green ramp).
  // Selected rows keep the brand accent; otherwise show the audit band color
  // (transparent when there's no audit data at all for this node).
  const auditBar = audit ? auditColor(audit.coverage) : "transparent";
  return (
    <div
      data-testid="workspace-tree-row"
      data-is-dir={node.isDir || undefined}
      data-has-vuln={node.hasVuln || undefined}
      data-selected={selected || undefined}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "5px 12px",
        paddingLeft: `${4 + node.depth * 12}px`,
        cursor: "pointer",
        fontSize: "13px",
        color: selected
          ? "var(--text-primary)"
          : node.isDir
            ? "var(--text-primary)"
            : "var(--text-secondary)",
        fontWeight: selected ? 600 : node.isDir ? 500 : 400,
        background: selected
          ? "var(--bg-card)"
          : "transparent",
        borderLeft: selected ? "4px solid var(--brand)" : `4px solid ${auditBar}`,
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
      {/* Icon column */}
      {node.isDir ? (
        <Icon
          name={node.collapsed ? "chevron-right" : "chevron-down"}
          size={14}
          style={{ color: "var(--text-secondary)", flexShrink: 0 }}
        />
      ) : (
        <Icon
          name="file-text"
          size={14}
          style={{ color: "var(--text-secondary)", flexShrink: 0, opacity: 0.7 }}
        />
      )}

      {/* Name */}
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

      {/* Vuln marker */}
      {node.hasVuln && (
        <span
          data-testid="workspace-tree-vuln-dot"
          title={i18n.t("workspace.vulnsInFile").replace("{n}", String(node.vulnCount))}
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: "var(--brand)",
            flexShrink: 0,
          }}
        />
      )}

      {/* Audit progress badge (审计进展) — A */}
      {audit ? <AuditBadge entry={audit} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Code viewer                                                               */
/* -------------------------------------------------------------------------- */

function CodeViewer({
  path,
  file,
  loading,
  error,
  vulnLines,
}: {
  path: string;
  file: WorkspaceFile | undefined;
  loading: boolean;
  error: Error | null;
  vulnLines: Set<number>;
}) {
  const streamRef = useRef<HTMLDivElement | null>(null);

  // When file loads, scroll to the first vuln line (if any).
  useEffect(() => {
    if (!file || vulnLines.size === 0) return;
    const firstLine = Math.min(...Array.from(vulnLines));
    const t = window.setTimeout(() => {
      const el = streamRef.current?.querySelector<HTMLElement>(
        `[data-ln="${firstLine}"]`,
      );
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
    return () => window.clearTimeout(t);
  }, [file, vulnLines]);

  const lines = useMemo(() => (file?.content ?? "").split("\n"), [file]);

  return (
    <>
      {/* Code header */}
      <div
        data-testid="workspace-code-header"
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
          data-testid="workspace-code-path"
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

      {/* Code body */}
      <div
        ref={streamRef}
        data-testid="workspace-code-body"
        translate="no"
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
            {i18n.t("workspace.error.file")}: {(error as Error).message}
          </div>
        ) : file?.type === "binary" ? (
          <div style={{ padding: "24px", color: "var(--text-secondary)", fontSize: "12px" }}>
            {i18n.t("workspace.binary")}
          </div>
        ) : (
          lines.map((line, i) => {
            const ln = i + 1;
            const isVuln = vulnLines.has(ln);
            return (
              <div
                key={ln}
                data-ln={ln}
                data-testid={isVuln ? "workspace-vuln-line" : undefined}
                style={{
                  display: "flex",
                  padding: "0 14px",
                  background: isVuln ? "var(--code-vuln-bg)" : "transparent",
                  borderLeft: isVuln
                    ? "3px solid var(--brand)"
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

function EmptyCodePlaceholder() {
  return (
    <div
      data-testid="workspace-empty"
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
      <span>{i18n.t("workspace.select")}</span>
    </div>
  );
}
