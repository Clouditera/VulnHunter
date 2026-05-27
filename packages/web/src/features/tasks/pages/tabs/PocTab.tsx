/**
 * POC/EXP Tab — two-column layout (Group B, 300px left).
 * Left: finding list with checkbox selection + POC status + generate button.
 * Right: 4-tab detail (Script / Output / Screenshots / Info).
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { useOutletContext } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import {
  api,
  type Task,
  type FindingMeta,
  type PocResult,
  type PocSummary,
} from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";
import { Icon } from "../../../../shared/components/Icon.js";
import { Splitter, useResizableWidth } from "../../../../shared/components/Splitter.js";
import type { LiveLogEvent } from "../../../live-log/components/LiveLog.js";
import { ReviewStatusBadge } from "../../components/FindingReviewControls.js";

/* ── Severity colors ── */
const SEV_COLORS: Record<string, string> = {
  high: "#dc2626",
  medium: "#f59e0b",
  low: "#3b82f6",
  info: "#6b7280",
};

/* ── POC status badge config ── */
const STATUS_BADGE: Record<string, { bg: string; color: string; label: string }> = {
  reproduced: { bg: "#dcfce7", color: "#166534", label: "已复现" },
  partial: { bg: "#fef3c7", color: "#78350f", label: "部分" },
  not_reproduced: { bg: "#fee2e2", color: "#991b1b", label: "未复现" },
  skipped: { bg: "var(--divider)", color: "var(--text-secondary)", label: "跳过" },
  error: { bg: "var(--bg-error, #fef2f2)", color: "var(--brand)", label: "错误" },
  pending: { bg: "transparent", color: "var(--text-secondary)", label: "—" },
  generating: { bg: "transparent", color: "var(--status-running)", label: "生成中" },
};

/* ── Right panel tab keys ── */
/* v1.2 (2026-04-25, fish): 脚本与输出合并为单一 Tab，上下分屏 */
type RightTab = "scriptAndOutput" | "screenshots" | "info";

/* ══════════════════════════════════════════════════════════════════════════ */

export function PocTab() {
  const { task } = useOutletContext<{ task: Task }>();
  const qc = useQueryClient();
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);

  // ── Data queries ──
  const { data: findingsData } = useQuery({
    queryKey: ["findings", task.id],
    queryFn: () => api.findings.list(task.id),
  });
  const findings: FindingMeta[] = (findingsData as { findings?: FindingMeta[] })?.findings ?? [];

  const { data: pocData } = useQuery({
    queryKey: ["poc-summary", task.id],
    queryFn: () => api.tasks.pocSummary(task.id),
    refetchInterval: 5000,
  });
  const summary: PocSummary | null = pocData ?? null;
  const resultsByKey = useMemo(() => {
    const m = new Map<string, PocResult>();
    for (const r of summary?.results ?? []) m.set(r.finding_key, r);
    return m;
  }, [summary]);

  // ── State ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeFinding, setActiveFinding] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("scriptAndOutput");
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showRunModal, setShowRunModal] = useState(false);
  const [pendingClearForFinding, setPendingClearForFinding] = useState<string | null>(null);

  // Toggle selection
  function toggleSelect(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function selectAll() {
    // Only select pending + confirmed findings
    const activeKeys = findings
      .filter((f) => !f.review_status || f.review_status === "pending" || f.review_status === "confirmed")
      .map((f) => f.finding_key);
    setSelected(new Set(activeKeys));
  }
  function clearSelection() {
    setSelected(new Set());
  }

  // Stats
  const stats = summary?.summary ?? { total: findings.length, reproduced: 0, partial: 0, not_reproduced: 0, error: 0, skipped: 0, pending: 0 };

  // Sort: pending/confirmed first, false_positive/ignored last
  const orderedFindings = useMemo(() => {
    const active = findings.filter((f) => !f.review_status || f.review_status === "pending" || f.review_status === "confirmed");
    const suppressed = findings.filter((f) => f.review_status === "false_positive" || f.review_status === "ignored");
    return { active, suppressed };
  }, [findings]);

  const [leftWidth, setLeftWidth] = useResizableWidth("poc-left-width", 300, { min: 240, max: 600 });
  const splitContainerRef = useRef<HTMLDivElement>(null);

  function renderPocFindingRow(f: FindingMeta, isSuppressed: boolean) {
    const result = resultsByKey.get(f.finding_key);
    const isActive = activeFinding === f.finding_key;
    const isChecked = selected.has(f.finding_key);
    const status = result?.status ?? "pending";

    return (
      <div
        key={f.finding_key}
        onClick={() => {
          setActiveFinding(f.finding_key);
          if (result?.poc_script_minio_key) setRightTab("scriptAndOutput");
          else setRightTab("info");
        }}
        style={{
          padding: "10px 16px",
          borderLeft: `2px solid ${isActive ? "var(--brand)" : "transparent"}`,
          background: isActive ? "var(--bg-card)" : "transparent",
          cursor: "pointer",
          transition: "background 0.12s",
          opacity: isSuppressed ? 0.5 : 1,
        }}
        onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div
            onClick={(e) => { e.stopPropagation(); toggleSelect(f.finding_key); }}
            style={{
              width: "16px", height: "16px", borderRadius: "3px",
              border: `1.5px solid ${isChecked ? "var(--brand)" : "var(--border)"}`,
              background: isChecked ? "var(--brand)" : "transparent",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0, cursor: "pointer",
            }}
          >
            {isChecked && <span style={{ color: "#fff", fontSize: "10px", fontWeight: 700 }}>✓</span>}
          </div>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: SEV_COLORS[f.severity] ?? "#6b7280", flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: "13px", fontWeight: isActive ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {f.finding_key}
          </span>
          {isSuppressed && f.review_status && (
            <ReviewStatusBadge status={f.review_status} muted />
          )}
          <PocStatusBadge status={status} />
        </div>
        {f.primary_file && (
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "3px", marginLeft: "34px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {f.primary_file}{f.primary_line ? `:${f.primary_line}` : ""}
          </div>
        )}
        {isSuppressed && (
          <div style={{ fontSize: "10px", fontStyle: "italic", color: "var(--text-secondary)", marginTop: "2px", marginLeft: "34px" }}>
            {f.review_status === "false_positive" ? i18n.t("review.poc.suppressed.false_positive") : i18n.t("review.poc.suppressed.ignored")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={splitContainerRef}
      data-testid="task-detail-panel-poc"
      style={{
        display: "flex",
        flex: 1,
        minHeight: 0,
        height: "100%",
        overflow: "hidden",
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "10px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      {/* ── Left panel (resizable) ── */}
      <div
        style={{
          width: `${leftWidth}px`,
          flexShrink: 0,
          background: "var(--bg-page)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Stats bar */}
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid var(--divider)",
            fontSize: "11px",
            display: "flex",
            flexWrap: "wrap",
            gap: "6px",
            alignItems: "center",
          }}
        >
          <StatItem n={stats.total} label="漏洞" />
          <Sep />
          <StatItem n={stats.reproduced} label="复现" />
          <Sep />
          <StatItem n={stats.partial} label="部分" />
          <Sep />
          <StatItem n={stats.not_reproduced} label="未复现" />
        </div>

        {/* Select all / clear */}
        <div
          style={{
            padding: "6px 16px",
            borderBottom: "1px solid var(--divider)",
            display: "flex",
            gap: "8px",
            fontSize: "11px",
          }}
        >
          <button onClick={selectAll} style={GHOST_SM}>全选</button>
          <button onClick={clearSelection} style={GHOST_SM}>清除</button>
          {selected.size > 0 && (
            <span style={{ color: "var(--text-secondary)", marginLeft: "auto" }}>
              已选 {selected.size}
            </span>
          )}
        </div>

        {/* Finding list */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {orderedFindings.active.map((f) => {
            return renderPocFindingRow(f, false);
          })}
          {orderedFindings.suppressed.length > 0 && (
            <div style={{ borderTop: "1px dashed var(--divider)", padding: "6px 16px", textAlign: "center", fontSize: 10, color: "var(--text-secondary)" }}>
              {i18n.t("review.poc.divider")} ({orderedFindings.suppressed.length})
            </div>
          )}
          {orderedFindings.suppressed.map((f) => {
            return renderPocFindingRow(f, true);
          })}
          {findings.length === 0 && (
            <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-secondary)", fontSize: "13px" }}>
              暂无漏洞
            </div>
          )}
        </div>

        {/* Footer — Generate button */}
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--divider)", flexShrink: 0 }}>
          <button
            onClick={() => setShowGenerateModal(true)}
            disabled={selected.size === 0}
            style={{
              width: "100%",
              padding: "9px 0",
              borderRadius: "6px",
              border: "none",
              fontSize: "13px",
              fontWeight: 600,
              cursor: selected.size > 0 ? "pointer" : "not-allowed",
              background: selected.size > 0 ? "var(--brand)" : "var(--bg-disabled, #e5e7eb)",
              color: selected.size > 0 ? "var(--btn-primary-text, #fff)" : "var(--text-secondary)",
              opacity: selected.size > 0 ? 1 : 0.6,
            }}
          >
            生成 POC{selected.size > 0 ? ` (已选 ${selected.size})` : ""}
          </button>
        </div>
      </div>

      {/* Resizable splitter */}
      <Splitter
        value={leftWidth}
        onResize={setLeftWidth}
        min={240}
        max={600}
        containerRef={splitContainerRef}
      />

      {/* ── Right panel ── */}
      <div style={{ flex: 1, minWidth: 0, background: "var(--bg-card)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {activeFinding ? (
          <PocDetail
            taskId={task.id}
            findingKey={activeFinding}
            finding={findings.find((f) => f.finding_key === activeFinding)!}
            result={resultsByKey.get(activeFinding) ?? null}
            rightTab={rightTab}
            setRightTab={setRightTab}
            onRunAgain={() => setShowRunModal(true)}
            isPendingClear={pendingClearForFinding === activeFinding}
            onPendingClearProcessed={() => setPendingClearForFinding(null)}
          />
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)", fontSize: "13px" }}>
            <div style={{ textAlign: "center" }}>
              <Icon name="chevron-left" size={32} style={{ opacity: 0.3, marginBottom: "12px" }} />
              <div>选择漏洞查看 POC 详情</div>
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {showGenerateModal && (
        <GenerateModal
          taskId={task.id}
          selectedKeys={Array.from(selected)}
          onClose={() => setShowGenerateModal(false)}
          onSuccess={() => {
            setShowGenerateModal(false);
            qc.invalidateQueries({ queryKey: ["poc-summary", task.id] });
            if (activeFinding) qc.invalidateQueries({ queryKey: ["poc-detail", task.id, activeFinding] });
          }}
        />
      )}
      {showRunModal && activeFinding && (
        <RunAgainModal
          taskId={task.id}
          findingKey={activeFinding}
          lastTargetUrl={resultsByKey.get(activeFinding)?.target_url ?? ""}
          onClose={() => setShowRunModal(false)}
          onSubmitStart={() => {
            setPendingClearForFinding(activeFinding);
            setRightTab("scriptAndOutput");
          }}
          onSuccess={() => {
            setShowRunModal(false);
            qc.invalidateQueries({ queryKey: ["poc-summary", task.id] });
            qc.invalidateQueries({ queryKey: ["poc-detail", task.id, activeFinding] });
          }}
        />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  Right panel detail                                                      */
/* ══════════════════════════════════════════════════════════════════════════ */

function PocDetail({
  taskId,
  findingKey,
  finding,
  result,
  rightTab,
  setRightTab,
  onRunAgain,
  isPendingClear,
  onPendingClearProcessed,
}: {
  taskId: string;
  findingKey: string;
  finding: FindingMeta;
  result: PocResult | null;
  rightTab: RightTab;
  setRightTab: (t: RightTab) => void;
  onRunAgain: () => void;
  isPendingClear: boolean;
  onPendingClearProcessed: () => void;
}) {
  const tabs: { key: RightTab; label: string }[] = [
    { key: "scriptAndOutput", label: "脚本与输出" },
    { key: "screenshots", label: "截图" },
    { key: "info", label: "信息" },
  ];

  return (
    <>
      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          borderBottom: "1px solid var(--divider)",
          padding: "0 16px",
          gap: "0",
          flexShrink: 0,
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setRightTab(t.key)}
            style={{
              padding: "10px 16px",
              border: "none",
              background: "transparent",
              fontSize: "13px",
              fontWeight: rightTab === t.key ? 600 : 400,
              color: rightTab === t.key ? "var(--text-primary)" : "var(--text-secondary)",
              borderBottom: rightTab === t.key ? "2px solid var(--brand)" : "2px solid transparent",
              cursor: "pointer",
              transition: "color 0.12s",
            }}
          >
            {t.label}
          </button>
        ))}

        {/* Right-side status badge only — actions moved into ScriptOutputPanel header */}
        {result?.poc_script_minio_key && result.status !== "pending" && (
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
            <PocStatusBadge status={result.status} />
          </div>
        )}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: "hidden", minHeight: 0, display: "flex", flexDirection: "column" }}>
        {rightTab === "scriptAndOutput" && (
          <ScriptOutputPanel
            taskId={taskId}
            findingKey={findingKey}
            result={result}
            onRunAgain={onRunAgain}
            isPendingClear={isPendingClear}
            onPendingClearProcessed={onPendingClearProcessed}
          />
        )}
        {rightTab === "screenshots" && <ScreenshotsPanel taskId={taskId} findingKey={findingKey} result={result} />}
        {rightTab === "info" && <InfoPanel finding={finding} result={result} />}
      </div>
    </>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  Script + Output combined panel (v1.2 — fish 2026-04-25)                  */
/*    Top: code viewer | Splitter (axis=y) | Bottom: status row + run log   */
/*    Unified action bar: Copy / Download / Run Again                        */
/* ══════════════════════════════════════════════════════════════════════════ */

function ScriptOutputPanel({
  taskId,
  findingKey,
  result,
  onRunAgain,
  isPendingClear,
  onPendingClearProcessed,
}: {
  taskId: string;
  findingKey: string;
  result: PocResult | null;
  onRunAgain: () => void;
  isPendingClear: boolean;
  onPendingClearProcessed: () => void;
}) {
  const hasScript = !!result?.poc_script_minio_key;
  const [copied, setCopied] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [topHeight, setTopHeight] = useResizableWidth(
    "poc-script-output-split",
    280,
    { min: 80, max: 800 },
  );

  /* ── Script content ── */
  const { data: script, isLoading: scriptLoading } = useQuery({
    queryKey: ["poc-script", taskId, findingKey],
    queryFn: () => api.tasks.pocScript(taskId, findingKey),
    enabled: hasScript,
  });

  /* ── Run detail (status header + log routing) ── */
  const { data: detail } = useQuery({
    queryKey: ["poc-detail", taskId, findingKey],
    queryFn: () => api.tasks.pocFindingDetail(taskId, findingKey),
    refetchInterval: (query) => {
      const runs = query.state.data?.runs ?? [];
      const hasActive = runs.some((r: { state: string }) => ["queued", "running"].includes(r.state));
      return hasActive ? 3000 : false;
    },
  });

  const latestRun = detail?.runs?.[0];
  const hasLog = !!result?.run_log_minio_key || !!latestRun?.run_log_minio_key;
  const isRunning = latestRun?.state === "running" || latestRun?.state === "queued";

  const { data: log } = useQuery({
    queryKey: ["poc-log", taskId, findingKey, latestRun?.id],
    queryFn: () => api.tasks.pocLog(taskId, findingKey),
    enabled: hasLog && !isRunning,
  });

  /* ── Live POC output stream (WS) — VS Code-style terminal feel ── */
  const [liveLines, setLiveLines] = useState<{ message: string; stream?: "stdout" | "stderr" }[]>([]);
  const liveLogRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  /* ── Execution pending: bridges the gap between user-click and server
        acknowledging the new run id. Without this, the old run's static log
        is still rendered for ~1-2s after "再次执行", confusing the user. */
  const [executionPending, setExecutionPending] = useState(false);
  const pendingTimerRef = useRef<number | null>(null);

  // Reset live buffer when run identity changes (new Run Again)
  useEffect(() => {
    setLiveLines([]);
  }, [latestRun?.id]);

  // Clear executionPending once the new run actually picks up.
  useEffect(() => {
    if (isRunning) {
      setExecutionPending(false);
      if (pendingTimerRef.current != null) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
    }
  }, [isRunning]);

  // Cleanup the failsafe timer on unmount.
  useEffect(() => {
    return () => {
      if (pendingTimerRef.current != null) {
        clearTimeout(pendingTimerRef.current);
      }
    };
  }, []);

  // Handler for opening the run-again modal
  function handleRunAgainClick() {
    onRunAgain();
  }

  // Respond to parent's pending-clear flag — fires on initial mount when
  // user clicked Run Again from another tab AND on subsequent toggles when
  // already on this tab. Parent ack'd back to null via onPendingClearProcessed.
  useEffect(() => {
    if (!isPendingClear) return;
    setLiveLines([]);
    setExecutionPending(true);
    if (pendingTimerRef.current != null) clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = window.setTimeout(() => {
      setExecutionPending(false);
      pendingTimerRef.current = null;
    }, 30000);
    onPendingClearProcessed();
  }, [isPendingClear, onPendingClearProcessed]);

  useEffect(() => {
    // Open WS as soon as we're either in the polling-gap window
    // (executionPending) or actually running. This way no events between user
    // click and first poll-update of latestRun.id are missed.
    if (!isRunning && !executionPending) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/ws/live-log`;
    const ws = new WebSocket(wsUrl);

    /* During subscribe, the server replays ALL buffered events (since_seq:-1)
       — including the PREVIOUS run's poc_output events. We must discard those
       and only render LIVE events that arrive after the snapshot_end marker.
       Otherwise the viewer fills up with stale completed-run output the moment
       WS opens, defeating the whole "clear on click" UX. */
    let inSnapshot = true;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", task_id: taskId, since_seq: -1 }));
    };

    ws.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as LiveLogEvent;

        // Snapshot replay finished — from now on, accept live events.
        if (ev.type === "snapshot_end") {
          inSnapshot = false;
          return;
        }
        if (ev.type === "ping") return;

        // Drop everything during snapshot replay (these are historical events
        // from past runs of this task).
        if (inSnapshot) return;

        if (ev.source !== "poc") return;
        if (ev.type !== "poc_output" && ev.type !== "poc_exit") return;

        // Filter to events for THIS finding (stage fallback works today;
        // explicit finding_key preferred once backend ships it).
        const matchesFinding =
          ev.finding_key === findingKey ||
          ev.stage?.endsWith(`/${findingKey}`) ||
          ev.stage === findingKey;
        if (!matchesFinding) return;

        if (ev.type === "poc_output") {
          const msg = ev.message ?? ev.text ?? "";
          if (!msg) return;
          setLiveLines((prev) => {
            // Cap at 2000 lines to avoid runaway memory on chatty POCs.
            const next = [...prev, { message: msg, stream: ev.stream }];
            return next.length > 2000 ? next.slice(-2000) : next;
          });
        } else if (ev.type === "poc_exit") {
          const code = ev.exit_code;
          const tag = code === 0 ? "✓ completed" : `✗ exit ${code ?? "?"}`;
          setLiveLines((prev) => [...prev, { message: `\n[poc-runner] ${tag}` }]);
        }
      } catch {
        /* ignore parse errors */
      }
    };

    return () => {
      ws.close();
    };
  }, [isRunning, executionPending, taskId, findingKey]);

  // Auto-scroll to bottom on new lines
  useEffect(() => {
    if (autoScroll && liveLogRef.current) {
      liveLogRef.current.scrollTop = liveLogRef.current.scrollHeight;
    }
  }, [liveLines, autoScroll]);

  async function handleCopy() {
    if (!script) return;
    await navigator.clipboard.writeText(script);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  function handleDownload() {
    if (!script) return;
    const blob = new Blob([script], { type: "text/x-shellscript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${findingKey}-poc.sh`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Unified action header */}
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--divider)",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          flexShrink: 0,
          background: "var(--bg-card)",
        }}
      >
        <span
          style={{
            fontSize: "12px",
            color: "var(--text-secondary)",
            fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          }}
        >
          {hasScript ? `${findingKey}-poc.sh` : "—"}
          {script && (
            <span style={{ marginLeft: "6px", opacity: 0.7 }}>
              · {(new Blob([script]).size / 1024).toFixed(1)}KB
            </span>
          )}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px" }}>
          <button
            onClick={handleCopy}
            disabled={!hasScript || !script}
            style={{ ...GHOST_SM, opacity: hasScript && script ? 1 : 0.4 }}
          >
            <Icon name={copied ? "check" : "copy"} size={12} />
            {copied ? "已复制" : "复制"}
          </button>
          <button
            onClick={handleDownload}
            disabled={!hasScript || !script}
            style={{ ...GHOST_SM, opacity: hasScript && script ? 1 : 0.4 }}
          >
            <Icon name="upload" size={12} style={{ transform: "rotate(180deg)" }} />
            下载
          </button>
          <button
            onClick={handleRunAgainClick}
            disabled={!hasScript || isRunning || executionPending}
            style={{
              padding: "5px 12px",
              border: "none",
              borderRadius: "5px",
              background: hasScript && !isRunning && !executionPending ? "var(--brand)" : "var(--bg-disabled)",
              color: hasScript && !isRunning && !executionPending ? "var(--btn-primary-text, #fff)" : "var(--text-secondary)",
              fontSize: "12px",
              fontWeight: 600,
              cursor: hasScript && !isRunning && !executionPending ? "pointer" : "not-allowed",
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              fontFamily: "inherit",
            }}
          >
            {(isRunning || executionPending) ? (
              <Icon name="loader" size={12} style={{ animation: "spin 1s linear infinite" }} />
            ) : (
              <Icon name="activity" size={12} />
            )}
            {(isRunning || executionPending) ? "执行中…" : "再次执行"}
          </button>
        </div>
      </div>

      {/* Splittable region: top script | y-splitter | bottom output */}
      <div ref={splitContainerRef} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        {/* TOP: script viewer */}
        <div style={{ height: `${topHeight}px`, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
          {!hasScript ? (
            <EmptyCenter icon="file" text="尚未生成 POC 脚本" />
          ) : scriptLoading ? (
            <EmptyCenter icon="loader" text="加载中..." />
          ) : (
            <pre
              translate="no"
              style={{
                flex: 1,
                margin: 0,
                padding: "14px 18px",
                background: "var(--code-bg)",
                color: "var(--code-text)",
                fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                fontSize: "12px",
                lineHeight: 1.6,
                overflow: "auto",
                whiteSpace: "pre",
              }}
            >
              {script ?? ""}
            </pre>
          )}
        </div>

        {/* Splitter (horizontal divider line, drag vertically) */}
        <Splitter
          axis="y"
          value={topHeight}
          onResize={setTopHeight}
          min={80}
          max={800}
          containerRef={splitContainerRef}
        />

        {/* BOTTOM: status row + run log */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {/* Status row — compact one-liner */}
          {latestRun && (
            <div
              style={{
                padding: "6px 18px",
                borderBottom: "1px solid var(--divider)",
                fontSize: "11px",
                color: "var(--text-secondary)",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                flexShrink: 0,
                background: "var(--bg-page)",
              }}
            >
              <span
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  background:
                    latestRun.state === "completed" ? "var(--status-completed)"
                    : latestRun.state === "failed" ? "var(--brand)"
                    : "var(--status-running)",
                }}
              />
              <span>执行 · {latestRun.state}</span>
              {latestRun.exit_code != null && <span>· exit {latestRun.exit_code}</span>}
              {latestRun.duration_ms != null && <span>· {(latestRun.duration_ms / 1000).toFixed(1)}s</span>}
              {latestRun.created_at && <span>· {new Date(latestRun.created_at).toLocaleTimeString()}</span>}
              {detail?.runs && detail.runs.length > 1 && <span style={{ marginLeft: "auto" }}>#{detail.runs.length}</span>}
            </div>
          )}

          {/* Log content */}
          {(isRunning || executionPending) ? (
            /* Live streaming via WebSocket — VS Code-style terminal */
            <div
              ref={liveLogRef}
              translate="no"
              onScroll={(e) => {
                const el = e.currentTarget;
                const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                if (atBottom !== autoScroll) setAutoScroll(atBottom);
              }}
              style={{
                flex: 1,
                background: "var(--code-bg)",
                color: "var(--code-text)",
                fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                fontSize: "12px",
                lineHeight: 1.65,
                padding: "14px 18px",
                overflow: "auto",
                minHeight: 0,
                position: "relative",
              }}
            >
              {liveLines.length === 0 ? (
                <div
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "12px",
                    fontStyle: "italic",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <Icon name="loader" size={12} style={{ animation: "spin 1s linear infinite" }} />
                  {executionPending && !isRunning ? "正在提交执行请求…" : "正在启动 POC 执行、连接输出流…"}
                </div>
              ) : (
                <>
                  {liveLines.map((line, i) => (
                    <div
                      key={i}
                      style={{
                        color: line.stream === "stderr" ? "var(--status-paused)" : undefined,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {line.message}
                    </div>
                  ))}
                  {/* Blinking cursor when no scroll-pause */}
                  <span
                    style={{
                      display: "inline-block",
                      width: "7px",
                      height: "14px",
                      background: "var(--code-text)",
                      verticalAlign: "middle",
                      animation: "poc-cursor-blink 1s step-end infinite",
                      opacity: 0.7,
                    }}
                  />
                </>
              )}
              {/* Inline keyframes (one-shot) */}
              <style>{`@keyframes poc-cursor-blink{50%{opacity:0}}`}</style>
              {!autoScroll && (
                <button
                  type="button"
                  onClick={() => {
                    setAutoScroll(true);
                    if (liveLogRef.current) {
                      liveLogRef.current.scrollTop = liveLogRef.current.scrollHeight;
                    }
                  }}
                  style={{
                    position: "sticky",
                    bottom: "8px",
                    float: "right",
                    marginRight: "4px",
                    padding: "4px 10px",
                    border: "1px solid var(--border)",
                    borderRadius: "4px",
                    background: "var(--bg-card)",
                    color: "var(--text-primary)",
                    fontSize: "11px",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  ⇩ 跳到底部
                </button>
              )}
            </div>
          ) : (
          <div
            translate="no"
            style={{
              flex: 1,
              background: "var(--code-bg)",
              color: "var(--code-text)",
              fontFamily: "'SF Mono', Menlo, Consolas, monospace",
              fontSize: "12px",
              lineHeight: 1.65,
              padding: !hasLog ? "0" : "14px 18px",
              overflow: "auto",
              minHeight: 0,
              display: !hasLog ? "flex" : "block",
              alignItems: !hasLog ? "center" : "stretch",
              justifyContent: !hasLog ? "center" : "flex-start",
            }}
          >
            {!hasLog ? (
              <div style={{ textAlign: "center", color: "var(--text-secondary)", fontSize: "12px", lineHeight: 1.7, padding: "24px" }}>
                尚未执行 POC
                {hasScript && (
                  <div style={{ marginTop: "12px" }}>
                    <button
                      onClick={handleRunAgainClick}
                      style={{
                        padding: "6px 14px",
                        border: "none",
                        borderRadius: "5px",
                        background: "var(--brand)",
                        color: "#fff",
                        fontSize: "12px",
                        fontWeight: 600,
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        fontFamily: "inherit",
                      }}
                    >
                      <Icon name="activity" size={12} /> 立即执行
                    </button>
                  </div>
                )}
              </div>
            ) : (
              (log ?? "").split("\n").map((line, i) => {
                const isStderr = line.startsWith("[stderr]");
                const display = isStderr ? line.slice(9) : line.startsWith("[stdout] ") ? line.slice(9) : line;
                return (
                  <div key={i} style={{ color: isStderr ? "var(--status-paused)" : undefined }}>
                    {display}
                  </div>
                );
              })
            )}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  Screenshots panel                                                       */
/* ══════════════════════════════════════════════════════════════════════════ */

function ScreenshotsPanel({ taskId, findingKey, result }: { taskId: string; findingKey: string; result: PocResult | null }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  // Fetch actual screenshot list from the detail API
  const { data: detailData } = useQuery({
    queryKey: ["poc-detail", taskId, findingKey],
    queryFn: () => api.tasks.pocFindingDetail(taskId, findingKey),
    enabled: !!result?.screenshots_prefix,
  });
  const screenshots: string[] = (detailData as { screenshots?: string[] })?.screenshots ?? [];

  if (!result?.screenshots_prefix || screenshots.length === 0) {
    return <EmptyCenter icon="image" text="暂无截图" />;
  }

  return (
    <div style={{ padding: "16px 24px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "12px" }}>
        {screenshots.map((name) => (
          <div
            key={name}
            onClick={() => setExpanded(name)}
            style={{
              borderRadius: "8px",
              border: "1px solid var(--border)",
              overflow: "hidden",
              cursor: "pointer",
              transition: "border-color 0.12s, box-shadow 0.12s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--brand)";
              e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.08)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--border)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <img
              src={`/api/tasks/${taskId}/poc/${findingKey}/screenshots/${name}`}
              alt={name}
              style={{ width: "100%", display: "block" }}
              onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = "none"; }}
            />
            <div style={{ padding: "6px 10px", fontSize: "11px", color: "var(--text-secondary)" }}>{name}</div>
          </div>
        ))}
      </div>

      {/* Lightbox */}
      {expanded && (
        <div
          onClick={() => setExpanded(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            cursor: "pointer",
          }}
        >
          <img
            src={`/api/tasks/${taskId}/poc/${findingKey}/screenshots/${expanded}`}
            alt={expanded}
            style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: "8px" }}
          />
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  Info panel                                                              */
/* ══════════════════════════════════════════════════════════════════════════ */

function InfoPanel({ finding, result }: { finding: FindingMeta; result: PocResult | null }) {
  const kvs: { label: string; value: string | JSX.Element }[] = [
    { label: "复现状态", value: result ? <PocStatusBadge status={result.status} /> : <span style={{ color: "var(--text-secondary)" }}>待生成</span> },
    { label: "漏洞 ID", value: finding.finding_key },
    { label: "漏洞类型", value: finding.vuln_type ?? "—" },
    { label: "严重等级", value: finding.severity.toUpperCase() },
    { label: "文件", value: finding.primary_file ? `${finding.primary_file}:${finding.primary_line ?? ""}` : "—" },
  ];

  if (result) {
    if (result.target_url) kvs.push({ label: "目标地址", value: result.target_url });
    if (result.summary) kvs.push({ label: "复现摘要", value: result.summary });
    if (result.exit_code != null) kvs.push({ label: "退出码", value: String(result.exit_code) });
    if (result.updated_at) kvs.push({ label: "最后更新", value: new Date(result.updated_at).toLocaleString() });
  }

  return (
    <div style={{ padding: "20px 24px" }}>
      {kvs.map((kv, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            padding: "10px 0",
            borderBottom: "1px solid var(--divider)",
            fontSize: "13px",
            gap: "16px",
          }}
        >
          <span style={{ width: "100px", flexShrink: 0, color: "var(--text-secondary)", fontWeight: 500 }}>
            {kv.label}
          </span>
          <span style={{ flex: 1, color: "var(--text-primary)" }}>{kv.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  Generate Modal                                                          */
/* ══════════════════════════════════════════════════════════════════════════ */

function GenerateModal({
  taskId,
  selectedKeys,
  onClose,
  onSuccess,
}: {
  taskId: string;
  selectedKeys: string[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [targetMode, setTargetMode] = useState<"provided" | "auto_deploy">("provided");
  const [targetUrl, setTargetUrl] = useState("");
  const [instructions, setInstructions] = useState("");
  const [browserTool, setBrowserTool] = useState("deveye");

  // Check DeVeye config
  const { data: pocSettingsData } = useQuery({
    queryKey: ["poc-settings"],
    queryFn: () => api.settings.getPocSettings(),
  });
  const defaultDeveyeServer = pocSettingsData?.settings?.deveye_server_url ?? "";
  const defaultDeveyeToken = pocSettingsData?.settings?.deveye_token ?? "";
  const [deveyeServer, setDeveyeServer] = useState("");
  const [deveyeToken, setDeveyeToken] = useState("");
  const [showDeveyeOverride, setShowDeveyeOverride] = useState(false);
  const [showSetupGuide, setShowSetupGuide] = useState(false);

  // Effective DeVeye config: override > global default
  const effectiveDeveyeServer = (showDeveyeOverride && deveyeServer.trim()) || defaultDeveyeServer.trim();
  const deveyeConfigured = !!effectiveDeveyeServer;

  const mut = useMutation({
    mutationFn: () =>
      api.tasks.pocGenerate(taskId, {
        finding_keys: selectedKeys,
        target_mode: targetMode,
        target_url: targetMode === "provided" ? targetUrl : undefined,
        custom_instructions: instructions || undefined,
        browser_tool: browserTool,
        deveye_server: showDeveyeOverride && deveyeServer.trim() ? deveyeServer.trim() : undefined,
        deveye_token: showDeveyeOverride && deveyeToken.trim() ? deveyeToken.trim() : undefined,
      }),
    onSuccess,
  });

  const deveyeBlocked = browserTool === "deveye" && !deveyeConfigured;
  const canSubmit =
    (targetMode === "auto_deploy" || (targetMode === "provided" && targetUrl.trim())) &&
    !deveyeBlocked;

  return (
    <ModalOverlay onClose={onClose}>
      <div style={MODAL_CONTAINER}>
        <div style={MODAL_HEADER}>
          <span style={{ fontSize: "15px", fontWeight: 600 }}>生成 POC</span>
          <button onClick={onClose} style={{ ...GHOST_SM, padding: "4px" }}><Icon name="x" size={16} /></button>
        </div>

        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            已选择 {selectedKeys.length} 个漏洞
          </div>

          {/* Target mode */}
          <div>
            <label style={LABEL}>目标环境</label>
            <div style={{ display: "flex", gap: "12px" }}>
              <RadioOption active={targetMode === "provided"} onClick={() => setTargetMode("provided")} label="已有环境（提供访问地址）" />
              <RadioOption active={targetMode === "auto_deploy"} onClick={() => setTargetMode("auto_deploy")} label="自动部署（从源码构建）" />
            </div>
          </div>

          {/* Target URL */}
          {targetMode === "provided" && (
            <div>
              <label style={LABEL}>目标地址</label>
              <input
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="http://192.168.1.100:8080"
                style={INPUT}
              />
            </div>
          )}

          {/* Instructions */}
          <div>
            <label style={LABEL}>自定义指令（可选）</label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="如：需要先登录后访问 /admin、目标环境限制、复现注意事项..."
              style={{ ...INPUT, minHeight: "72px", resize: "vertical" }}
            />
          </div>

          {/* Browser tool — DeVeye only for now, Playwright deferred to v1.2 */}
          <div>
            <label style={LABEL}>浏览器工具</label>
            <select value={browserTool} onChange={(e) => setBrowserTool(e.target.value)} style={INPUT}>
              <option value="deveye">DeVeye</option>
              <option value="playwright" disabled>
                Playwright（即将推出）
              </option>
            </select>
            {browserTool === "deveye" && deveyeConfigured && (
              <div style={{ fontSize: "11px", color: "var(--status-completed, #16a34a)", marginTop: "4px" }}>
                ✓ 已连接到 {effectiveDeveyeServer}
              </div>
            )}
            {browserTool === "deveye" && !deveyeConfigured && !showDeveyeOverride && (
              <div style={{
                marginTop: "8px", padding: "10px 14px", borderRadius: "6px",
                background: "#fff7ed", border: "1px solid #fed7aa",
                fontSize: "12px", color: "#9a3412", lineHeight: 1.55,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <Icon name="alert-triangle" size={14} />
                  <span style={{ fontWeight: 600 }}>DeVeye Server 未配置</span>
                </div>
                <div style={{ marginTop: "4px" }}>
                  请在下方填写 Server URL 和 Token，或在 Settings → POC/EXP 设置中配置默认值。
                </div>
                <button
                  type="button"
                  onClick={() => setShowSetupGuide(!showSetupGuide)}
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    fontSize: "12px", color: "#c2410c", padding: "6px 0 0",
                    fontWeight: 600, fontFamily: "inherit",
                  }}
                >
                  {showSetupGuide ? "▾" : "▸"} 还未部署？5 分钟快速部署
                </button>
                {showSetupGuide && (
                  <div style={{
                    marginTop: "10px",
                    padding: "10px 12px",
                    background: "#fff",
                    border: "1px dashed #fdba74",
                    borderRadius: "6px",
                    color: "#374151",
                  }}>
                    <div style={{ fontSize: "11px", color: "#6b7280", marginBottom: "6px" }}>
                      在有桌面 + Chrome 的机器上：
                    </div>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "8px" }}>
                      <SetupDownloadBtn platform="linux" label="Linux" />
                      <SetupDownloadBtn platform="windows" label="Windows" />
                      <SetupDownloadBtn platform="macos" label="macOS" />
                    </div>
                    <pre style={{
                      margin: 0, padding: "8px 10px",
                      background: "#f8fafc", border: "1px solid #e2e8f0",
                      borderRadius: "4px", fontFamily: "'SF Mono', Menlo, monospace",
                      fontSize: "11px", lineHeight: 1.55, color: "#0f172a",
                      whiteSpace: "pre", overflow: "auto",
                    }}>
{`# 解压后启动 Server
bash setup.sh   # Linux/macOS
setup.bat       # Windows
deveye server start --host 0.0.0.0 --port 9888 \\
  --token <your-token> --extension-path ./extension-dist --daemon`}
                    </pre>
                    <div style={{ marginTop: "8px", fontSize: "11px", color: "#6b7280" }}>
                      启动后返回下方填入 Server URL + Token，或
                      <a
                        href="/settings#poc"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ marginLeft: "4px", color: "#2563eb", textDecoration: "none" }}
                      >
                        前往 Settings 设置默认值 →
                      </a>
                    </div>
                  </div>
                )}
              </div>
            )}
            {browserTool === "deveye" && (
              <div style={{ marginTop: "8px" }}>
                <button
                  type="button"
                  onClick={() => setShowDeveyeOverride(!showDeveyeOverride)}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: "var(--text-secondary)", padding: 0, fontFamily: "inherit" }}
                >
                  {showDeveyeOverride ? "▾" : "▸"} 自定义 DeVeye Server
                </button>
                {showDeveyeOverride && (
                  <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div>
                      <label style={{ ...LABEL, fontSize: "11px" }}>Server URL</label>
                      <input
                        value={deveyeServer}
                        onChange={(e) => setDeveyeServer(e.target.value)}
                        placeholder={defaultDeveyeServer || "ws://192.168.1.100:9222"}
                        style={INPUT}
                      />
                    </div>
                    <div>
                      <label style={{ ...LABEL, fontSize: "11px" }}>Token</label>
                      <input
                        type="password"
                        value={deveyeToken}
                        onChange={(e) => setDeveyeToken(e.target.value)}
                        placeholder={defaultDeveyeToken ? "•••••••• (默认值)" : "可选"}
                        style={INPUT}
                      />
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                      留空使用 Settings 中的默认值
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div style={MODAL_FOOTER}>
          <button onClick={onClose} style={GHOST_SM}>取消</button>
          <button
            onClick={() => mut.mutate()}
            disabled={!canSubmit || mut.isPending}
            style={{
              ...PRIMARY_BTN,
              opacity: canSubmit && !mut.isPending ? 1 : 0.6,
              cursor: canSubmit && !mut.isPending ? "pointer" : "not-allowed",
            }}
          >
            {mut.isPending ? "提交中..." : "开始生成"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  Run Again Modal                                                         */
/* ══════════════════════════════════════════════════════════════════════════ */

function RunAgainModal({
  taskId,
  findingKey,
  lastTargetUrl,
  onClose,
  onSubmitStart,
  onSuccess,
}: {
  taskId: string;
  findingKey: string;
  lastTargetUrl: string;
  onClose: () => void;
  onSubmitStart?: () => void;
  onSuccess: () => void;
}) {
  const [targetUrl, setTargetUrl] = useState(lastTargetUrl);
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState("");

  const mut = useMutation({
    mutationFn: () =>
      api.tasks.pocRun(taskId, findingKey, {
        target_url: targetUrl || undefined,
        custom_instructions: instructions || undefined,
      }),
    onSuccess,
    onError: (err: Error & { code?: string }) => {
      if (err.code === "ERR_TASK_BUSY" || err.message?.includes("TASK_BUSY")) {
        setError("当前任务有正在执行的操作，请稍后再试");
      } else {
        setError(err.message || "执行失败");
      }
    },
  });

  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ ...MODAL_CONTAINER, width: "400px" }}>
        <div style={MODAL_HEADER}>
          <span style={{ fontSize: "15px", fontWeight: 600 }}>再次执行 — {findingKey}</span>
          <button onClick={onClose} style={{ ...GHOST_SM, padding: "4px" }}><Icon name="x" size={16} /></button>
        </div>

        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <div>
            <label style={LABEL}>目标地址</label>
            <input
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="http://..."
              style={INPUT}
            />
          </div>
          <div>
            <label style={LABEL}>自定义指令（可选）</label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              style={{ ...INPUT, minHeight: "60px", resize: "vertical" }}
            />
          </div>
          {error && <div style={{ color: "var(--brand)", fontSize: "12px", padding: "0 0 4px" }}>{error}</div>}
        </div>

        <div style={MODAL_FOOTER}>
          <button onClick={onClose} style={GHOST_SM}>取消</button>
          <button
            onClick={() => { setError(""); onSubmitStart?.(); mut.mutate(); }}
            disabled={mut.isPending}
            style={{ ...PRIMARY_BTN, opacity: mut.isPending ? 0.6 : 1 }}
          >
            {mut.isPending ? "执行中..." : "执行"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  Shared UI primitives                                                    */
/* ══════════════════════════════════════════════════════════════════════════ */

function PocStatusBadge({ status }: { status: string }) {
  const cfg = STATUS_BADGE[status] ?? STATUS_BADGE.pending;
  if (status === "pending") return <span style={{ color: cfg.color, fontSize: "11px" }}>—</span>;
  return (
    <span
      style={{
        fontSize: "10px",
        fontWeight: 600,
        padding: "2px 7px",
        borderRadius: "4px",
        background: cfg.bg,
        color: cfg.color,
        whiteSpace: "nowrap",
      }}
    >
      {cfg.label}
    </span>
  );
}

function StatItem({ n, label }: { n: number; label: string }) {
  return (
    <span>
      <span style={{ fontWeight: 600, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{n}</span>
      <span style={{ color: "var(--text-secondary)", marginLeft: "3px" }}>{label}</span>
    </span>
  );
}

function Sep() {
  return <span style={{ color: "var(--text-secondary)", opacity: 0.3 }}>·</span>;
}

function EmptyCenter({ icon, text }: { icon: string; text: string }) {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-secondary)", fontSize: "13px" }}>
      <div style={{ textAlign: "center" }}>
        <Icon name={icon as never} size={28} style={{ opacity: 0.3, marginBottom: "10px" }} />
        <div>{text}</div>
      </div>
    </div>
  );
}

function RadioOption({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: "8px 12px",
        border: `1px solid ${active ? "var(--brand)" : "var(--border)"}`,
        borderRadius: "6px",
        background: active ? "rgba(var(--brand-rgb, 220,38,38), 0.05)" : "transparent",
        color: active ? "var(--brand)" : "var(--text-primary)",
        fontSize: "12px",
        fontWeight: active ? 600 : 400,
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      {label}
    </button>
  );
}

function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
    >
      <div onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/* ── Shared styles ── */

const GHOST_SM: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  padding: "4px 10px",
  border: "none",
  borderRadius: "4px",
  background: "transparent",
  color: "var(--text-secondary)",
  fontSize: "12px",
  fontWeight: 500,
  cursor: "pointer",
};

const LABEL: CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--text-primary)",
  marginBottom: "6px",
};

const INPUT: CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "13px",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  outline: "none",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const PRIMARY_BTN: CSSProperties = {
  padding: "8px 20px",
  border: "none",
  borderRadius: "6px",
  background: "var(--brand)",
  color: "var(--btn-primary-text, #fff)",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
};

const MODAL_CONTAINER: CSSProperties = {
  width: "480px",
  maxHeight: "80vh",
  borderRadius: "12px",
  background: "var(--bg-card)",
  boxShadow: "0 20px 60px rgba(0,0,0,0.15)",
  overflow: "hidden",
};

const MODAL_HEADER: CSSProperties = {
  padding: "18px 24px",
  borderBottom: "1px solid var(--divider)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const MODAL_FOOTER: CSSProperties = {
  padding: "16px 24px",
  borderTop: "1px solid var(--divider)",
  display: "flex",
  justifyContent: "flex-end",
  gap: "8px",
};

/* ── Compact toolkit download button for in-modal "5-min setup" guide ── */
function SetupDownloadBtn({ platform, label }: { platform: "linux" | "windows" | "macos"; label: string }) {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent.toLowerCase() : "";
  const detected: typeof platform =
    ua.includes("win") ? "windows" : ua.includes("mac") ? "macos" : "linux";
  const highlight = detected === platform;
  return (
    <a
      href={`/api/downloads/deveye/toolkit?platform=${platform}`}
      download
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "4px 10px",
        borderRadius: "4px",
        fontSize: "11px",
        fontWeight: 600,
        textDecoration: "none",
        background: highlight ? "#c2410c" : "#fff",
        color: highlight ? "#fff" : "#c2410c",
        border: `1px solid ${highlight ? "#c2410c" : "#fdba74"}`,
        cursor: "pointer",
      }}
    >
      ⬇ {label}
    </a>
  );
}
