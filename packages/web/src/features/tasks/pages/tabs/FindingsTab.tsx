import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { useOutletContext } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type FindingDetail as FindingDetailData,
  type FindingMeta,
  type FindingReviewStatus,
  type Task,
} from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";
import { Icon } from "../../../../shared/components/Icon.js";
import { Splitter, useResizableWidth } from "../../../../shared/components/Splitter.js";
import { ReviewStatusBadge, ReviewStatusSelect, ReviewHistoryTimeline, ReviewNoteModal, REVIEW_STATUS_META } from "../../components/FindingReviewControls.js";
import { FindingPocPanel, FindingExpPanel, resolvePocTabPill, resolveExpTabPill } from "../../components/FindingDynamicCards.js";
import { FindingDetailV3 } from "../../components/FindingDetailV3.js";

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

function normalizePath(raw: string): string {
  return raw.replace(/^\/+workspace\/+/, "").replace(/^\/+/, "");
}



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
  const [LEFT_PANEL_WIDTH, setLeftPanelWidth] = useResizableWidth("findings-left-width", 260, { min: 200, max: 600 });
  const splitContainerRef = useRef<HTMLDivElement>(null);

  /** Right-side sub-tabs: 漏洞详情 / 动态验证 / 可利用性评估. */
  const [rightView, setRightView] = useState<"detail" | "poc" | "exp">("detail");

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

  /* -------- Interaction handlers -------- */

  function handlePickFinding(f: FindingMeta) {
    setSelectedFindingId((cur) => (cur === f.id ? null : f.id));
    setRightView("detail");
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
          {/* Tab bar — 漏洞详情 / 动态验证 / 可利用性评估 */}
          <div
            data-testid="findings-right-tabs"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0",
              borderBottom: "1px solid var(--divider)",
              background: "var(--bg-card)",
              flexShrink: 0,
              overflowX: "auto",
              whiteSpace: "nowrap",
            }}
          >
            {([
              { id: "detail" as const, label: i18n.t("findings.tab.detail"), pill: null },
              {
                id: "poc" as const,
                label: i18n.t("findings.tab.poc"),
                pill: selectedFinding ? resolvePocTabPill(selectedFinding, dynamicEnabled) : null,
              },
              {
                id: "exp" as const,
                label: i18n.t("findings.tab.exp"),
                pill: selectedFinding ? resolveExpTabPill(selectedFinding, dynamicEnabled) : null,
              },
            ]).map((tab) => {
              const active = rightView === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={`findings-tab-${tab.id}`}
                  onClick={() => setRightView(tab.id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "10px 16px",
                    border: "none",
                    borderBottom: active
                      ? "2px solid var(--brand)"
                      : "2px solid transparent",
                    background: "transparent",
                    color: active
                      ? "var(--brand)"
                      : "var(--text-secondary)",
                    fontSize: "12.5px",
                    fontWeight: active ? 600 : 400,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "color 0.12s, border-color 0.12s",
                    flexShrink: 0,
                    lineHeight: 1,
                    height: "40px",
                    boxSizing: "border-box",
                  }}
                >
                  {tab.label}
                  {tab.pill ? (
                    <span
                      data-testid={`findings-tab-${tab.id}-pill`}
                      style={{
                        fontSize: "9.5px",
                        fontWeight: 700,
                        borderRadius: "8px",
                        padding: "1px 6px",
                        background: tab.pill.background,
                        color: tab.pill.color,
                        border: tab.pill.border,
                        lineHeight: 1.4,
                      }}
                    >
                      {tab.pill.label}
                    </span>
                  ) : null}
                </button>
              );
            })}
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
                  flexShrink: 0,
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
            {!selectedFinding ? (
              <EmptyState icon="chevron-left" text={i18n.t("findings.detail.placeholder")} />
            ) : rightView === "detail" ? (
              <FindingDetailPanel
                taskId={task.id}
                finding={selectedFinding}
                detail={detailData?.detail}
                loading={detailLoading}
                error={detailError as Error | null}
                dynamicEnabled={dynamicEnabled}
              />
            ) : rightView === "poc" ? (
              <FindingPocPanel taskId={task.id} finding={selectedFinding} dynamicEnabled={dynamicEnabled} />
            ) : (
              <FindingExpPanel taskId={task.id} finding={selectedFinding} dynamicEnabled={dynamicEnabled} />
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
}: {
  taskId: string;
  finding: FindingMeta;
  detail: FindingDetailData | undefined;
  loading: boolean;
  error: Error | null;
  dynamicEnabled?: boolean;
}) {
  return (
    <FindingDetailV3
      taskId={taskId}
      finding={finding}
      detail={detail}
      loading={loading}
      error={error}
      dynamicEnabled={dynamicEnabled}
      reviewSlot={<FindingReviewSection taskId={taskId} finding={finding} />}
    />
  );
}







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
