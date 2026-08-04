import { useState, useEffect } from "react";
import { useParams, useNavigate, NavLink, Outlet } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Task } from "../../../shared/api/client.js";
import { LiveLog } from "../../live-log/components/LiveLog.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon, type IconName } from "../../../shared/components/Icon.js";
import { StatusPill } from "../../../shared/components/StatusPill.js";
import { effectiveTaskState, isTaskTimedOut } from "../task-timeout.js";
import { formatDateTime } from "../../../shared/utils/format.js";

const TABS = [
  { labelKey: "taskDetail.tab.overview", path: "" },
  { labelKey: "taskDetail.tab.workspace", path: "workspace" },
  { labelKey: "taskDetail.tab.wiki", path: "wiki" },
  { labelKey: "taskDetail.tab.findings", path: "findings" },
  { labelKey: "taskDetail.tab.exploits", path: "exploits" },
  { labelKey: "taskDetail.tab.reports", path: "reports" },
];

function formatDuration(ms: number | null): string {
  if (!ms || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m}m`;
}

/**
 * Live duration for running tasks: backend leaves `duration_ms` null while
 * running, so we compute it from `started_at`. Re-renders every second via
 * a timer hook so the value ticks without waiting for the 3s poll.
 */
function useLiveDurationMs(
  task: { state: string; started_at: string | null; duration_ms: number | null },
): number | null {
  const [now, setNow] = useState(() => Date.now());
  const isLive =
    (task.state === "running" || task.state === "paused") &&
    !!task.started_at;
  useEffect(() => {
    if (!isLive) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isLive]);
  if (isLive && task.started_at) {
    return Math.max(0, now - Date.parse(task.started_at));
  }
  return task.duration_ms;
}

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [, forceUpdate] = useState(0);
  useEffect(() => i18n.onChange(() => forceUpdate((n) => n + 1)), []);

  const { data, isLoading } = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.tasks.get(taskId!),
    enabled: !!taskId,
    // No refetchInterval: server SSE (`task_state` event) invalidates
    // this cache key whenever the task transitions.
  });

  // Shared findings query — also used inside OverviewTab/FindingsTab via same cache key.
  const { data: findingsData } = useQuery({
    queryKey: ["findings", taskId],
    queryFn: () => api.findings.list(taskId!),
    enabled: !!taskId,
    // Server SSE (`findings_indexed`) invalidates when new findings land.
  });
  const findingsCount = findingsData?.findings?.length ?? 0;

  // Live-updating duration for running/paused tasks (re-ticks every 1s).
  // Safe to call unconditionally before the early-return; returns null
  // while task is still loading and falls through to task.duration_ms.
  const liveDurationMs = useLiveDurationMs(
    data?.task ?? { state: "", started_at: null, duration_ms: null },
  );

  const cancelMut = useMutation({
    mutationFn: () => api.tasks.cancel(taskId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["task", taskId] }),
  });
  const pauseMut = useMutation({
    mutationFn: () => api.tasks.pause(taskId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["task", taskId] }),
  });
  const resumeMut = useMutation({
    mutationFn: () => api.tasks.resume(taskId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["task", taskId] }),
  });
  const restartMut = useMutation({
    mutationFn: () => api.tasks.restart(taskId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["task", taskId] }),
  });
  const [continueDialogOpen, setContinueDialogOpen] = useState(false);
  const [continueFocus, setContinueFocus] = useState("");
  const [continueDuration, setContinueDuration] = useState("60");
  /** Open the continue-scan dialog prefilled from the task's source metadata. */
  function openContinueDialog() {
    const meta = (task as Task & { source_meta?: Record<string, unknown> }).source_meta ?? {};
    setContinueFocus(typeof meta.audit_focus === "string" ? meta.audit_focus : "");
    const t = Number(meta.scan_timeout);
    setContinueDuration(Number.isFinite(t) && t > 0 ? String(Math.round(t / 60)) : "60");
    setContinueDialogOpen(true);
  }
  const continueMut = useMutation({
    mutationFn: () => {
      const min = Number.parseInt(continueDuration, 10);
      const scan_timeout = Number.isFinite(min) && min > 0 ? min * 60 : undefined;
      const focus = continueFocus.trim();
      return api.tasks.continue(taskId!, {
        audit_focus: focus || undefined,
        scan_timeout,
      });
    },
    onSuccess: () => {
      setContinueDialogOpen(false);
      qc.invalidateQueries({ queryKey: ["task", taskId] });
    },
  });
  const [editingName, setEditingName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const displayNameMut = useMutation({
    mutationFn: (name: string) => api.tasks.updateDisplayName(taskId!, name),
    onSuccess: () => {
      setEditingName(false);
      qc.invalidateQueries({ queryKey: ["task", taskId] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const task = data?.task as Task | undefined;
  const headerSeverityCounts = {
    high: findingsData?.findings?.filter((f) => f.severity === "high").length ?? task?.severity_counts?.high ?? 0,
    medium: findingsData?.findings?.filter((f) => f.severity === "medium").length ?? task?.severity_counts?.medium ?? 0,
    low: findingsData?.findings?.filter((f) => f.severity === "low").length ?? task?.severity_counts?.low ?? 0,
    info: findingsData?.findings?.filter((f) => f.severity === "info").length ?? task?.severity_counts?.info ?? 0,
  };

  if (isLoading) {
    return (
      <div style={{ padding: "40px", color: "var(--text-secondary)" }}>
        {i18n.t("taskDetail.loading")}
      </div>
    );
  }

  if (!task) {
    return (
      <div style={{ padding: "40px", color: "var(--brand)" }}>
        {i18n.t("taskDetail.notFound")}
      </div>
    );
  }

  const tabCounts: Record<string, number | undefined> = {
    findings: findingsCount > 0 ? findingsCount : undefined,
    // reports / poc counts not yet wired
  };

  return (
    <div
      data-testid="task-detail-page"
      style={{
        minHeight: "100vh",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-page)",
      }}
    >
      {/* Topbar */}
      <div
        data-testid="task-topbar"
        style={{
          background: "var(--bg-card)",
          borderBottom: "1px solid var(--border)",
          padding: "22px 40px 24px",
        }}
      >
        {/* Back link */}
        <button
          data-testid="back-to-tasks"
          onClick={() => navigate("/tasks")}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-secondary)",
            fontSize: "13px",
            fontWeight: 500,
            lineHeight: 1,
            padding: 0,
            marginBottom: "18px",
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            transition: "color 0.15s",
          }}
        >
          <Icon name="arrow-left" size={16} style={{ display: "block" }} />
          <span style={{ lineHeight: 1 }}>{i18n.t("taskDetail.back")}</span>
        </button>

        {/* Title row: name + status pill inline */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Title + status pill row.
                Center alignment (mid-line), matching the prototype.
                h1 gets lineHeight 1 so its box height == its glyph height,
                which means 'center' aligns the visual glyph center with
                the pill's label center — not the box centers of oversized
                line-boxes. Fish #10 v2 feedback. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                flexWrap: "wrap",
              }}
            >
              <h1
                data-testid="task-project-name"
                style={{
                  fontSize: "22px",
                  fontWeight: 700,
                  margin: 0,
                  letterSpacing: "-0.01em",
                  lineHeight: 1,
                }}
              >
                {task.display_name?.trim() || task.project_name}
              </h1>
              {editingName ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <input data-testid="task-display-name-input" value={displayNameDraft} onChange={(e) => setDisplayNameDraft(e.target.value)} maxLength={120} placeholder={task.project_name} style={{ height: 30, border: "1px solid var(--border)", borderRadius: 6, padding: "0 8px", background: "var(--bg-card)", color: "var(--text-primary)" }} />
                  <button data-testid="task-display-name-save" onClick={() => displayNameMut.mutate(displayNameDraft)} style={{ height: 30, border: "1px solid var(--brand)", borderRadius: 6, background: "var(--brand)", color: "#fff", padding: "0 10px", cursor: "pointer" }}>{i18n.t("tasks.saveDisplayName")}</button>
                  <button data-testid="task-display-name-clear" onClick={() => { setDisplayNameDraft(""); displayNameMut.mutate(""); }} style={{ height: 30, border: "1px solid var(--border)", borderRadius: 6, background: "transparent", color: "var(--text-secondary)", padding: "0 10px", cursor: "pointer" }}>{i18n.t("tasks.clearDisplayName")}</button>
                  <button onClick={() => setEditingName(false)} style={{ height: 30, border: "1px solid var(--border)", borderRadius: 6, background: "transparent", color: "var(--text-secondary)", padding: "0 10px", cursor: "pointer" }}>{i18n.t("tasks.cancelDisplayName")}</button>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{i18n.t("tasks.displayNameClearHint")}</span>
                </span>
              ) : (
                <button data-testid="task-display-name-edit" title={i18n.t("tasks.editDisplayName")} onClick={() => { setDisplayNameDraft(task.display_name ?? ""); setEditingName(true); }} style={{ border: "none", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", padding: 2 }}>
                  <Icon name="edit" size={14} />
                </button>
              )}
              <span style={{ display: "inline-flex", alignItems: "center", lineHeight: 0, gap: "8px" }}>
                <StatusPill state={effectiveTaskState(task)} />
              </span>
            </div>
            {task.display_name?.trim() ? (
              <div data-testid="task-project-identity" style={{ marginTop: 8, fontSize: 12, color: "var(--text-secondary)" }}>
                {i18n.t("tasks.projectIdentity").replace("{name}", task.project_name)}
              </div>
            ) : null}

            {/* Meta row: Findings · Duration · Started */}
            <div
              style={{
                display: "flex",
                gap: "22px",
                marginTop: "14px",
                fontSize: "13px",
                color: "var(--text-secondary)",
                flexWrap: "wrap",
              }}
            >
              <MetaItem icon="alert-triangle">
                {i18n.t("taskDetail.meta.findings")}: {" "}
                <strong style={{ color: "var(--text-primary)", marginLeft: "4px" }}>
                  {findingsCount > 0 ? findingsCount : "—"}
                </strong>
                {findingsCount > 0 && (
                  <span style={{ marginLeft: "8px", color: "var(--text-secondary)" }}>
                    {i18n.t("findings.sevHigh")} {headerSeverityCounts.high} · {i18n.t("findings.sevMedium")} {headerSeverityCounts.medium} · {i18n.t("findings.sevLow")} {headerSeverityCounts.low}
                  </span>
                )}
              </MetaItem>
              <MetaItem icon="clock">
                {i18n.t("taskDetail.meta.duration")}:{" "}
                <strong style={{ color: "var(--text-primary)", marginLeft: "4px" }}>
                  {formatDuration(liveDurationMs)}
                </strong>
              </MetaItem>
              <MetaItem icon="calendar">
                {i18n.t("taskDetail.meta.started")}:{" "}
                <strong style={{ color: "var(--text-primary)", marginLeft: "4px" }}>
                  {formatDateTime(task.started_at)}
                </strong>
              </MetaItem>
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
            {task.state === "running" && (
              <button
                data-testid="task-pause-btn"
                onClick={() => pauseMut.mutate()}
                disabled={pauseMut.isPending}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                style={{
                  padding: "7px 14px",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  background: "transparent",
                  color: "var(--text-primary)",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: pauseMut.isPending ? "not-allowed" : "pointer",
                  transition: "background 0.15s",
                }}
              >
                {pauseMut.isPending ? i18n.t("taskDetail.pausing") : i18n.t("taskDetail.pause")}
              </button>
            )}
            {task.state === "paused" && (
              <button
                data-testid="task-resume-btn"
                onClick={() => resumeMut.mutate()}
                disabled={resumeMut.isPending}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--danger-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "var(--brand)")}
                style={{
                  padding: "7px 14px",
                  border: "1px solid var(--brand)",
                  borderRadius: "6px",
                  background: "var(--brand)",
                  color: "var(--btn-primary-text)",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: resumeMut.isPending ? "not-allowed" : "pointer",
                  transition: "background 0.15s",
                }}
              >
                {resumeMut.isPending ? i18n.t("taskDetail.resuming") : i18n.t("taskDetail.resume")}
              </button>
            )}
            {["running", "queued", "paused", "preparing"].includes(task.state) && (
              <button
                data-testid="task-cancel-btn"
                onClick={() => cancelMut.mutate()}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-error)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                style={{
                  padding: "7px 14px",
                  border: "1px solid var(--status-failed)",
                  borderRadius: "6px",
                  background: "transparent",
                  color: "var(--status-failed)",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "background 0.15s",
                }}
              >
                {i18n.t("taskDetail.cancel")}
              </button>
            )}
            {["failed", "cancelled", "completed"].includes(task.state) && (
              <button
                data-testid="task-restart-btn"
                onClick={() => restartMut.mutate()}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--danger-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "var(--brand)")}
                style={{
                  padding: "7px 14px",
                  border: "1px solid var(--brand)",
                  borderRadius: "6px",
                  background: "var(--brand)",
                  color: "var(--btn-primary-text)",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "background 0.15s",
                }}
              >
                {i18n.t("taskDetail.restart")}
              </button>
            )}
            {["failed", "cancelled", "completed"].includes(task.state) && (
              <button
                data-testid="task-continue-btn"
                onClick={openContinueDialog}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-error)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                style={{
                  padding: "7px 14px",
                  border: "1px solid var(--brand)",
                  borderRadius: "6px",
                  background: "transparent",
                  color: "var(--brand)",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "background 0.15s",
                }}
              >
                {i18n.t("taskDetail.continue")}
              </button>
            )}
          </div>
        </div>

        {/* Failure banner (when state=failed) */}
        {task.state === "failed" && <FailureBanner task={task} />}

        {/* Timeout banner — time budget exhausted, dynamic verification
            didn't finish; nudge to continue-scan (task-a3d095ad). */}
        {isTaskTimedOut(task) && <TimeoutBanner onContinue={openContinueDialog} />}

        {/* Continue-scan dialog */}
        {continueDialogOpen && (
          <div
            data-testid="continue-scan-dialog"
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}
            onMouseDown={(e) => { if (e.target === e.currentTarget) setContinueDialogOpen(false); }}
          >
            <div style={{ background: "var(--bg-card)", borderRadius: "10px", width: "460px", boxShadow: "0 20px 60px rgba(0,0,0,0.15)", overflow: "hidden" }}>
              <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--border)" }}>
                <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>{i18n.t("taskDetail.continueTitle")}</h2>
                <p style={{ margin: "6px 0 0", fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                  {i18n.t("taskDetail.continueHint")}
                </p>
              </div>
              <div style={{ padding: "24px" }}>
                <div style={{ marginBottom: "16px" }}>
                  <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "6px" }}>
                    {i18n.t("newTask.auditFocus")}
                  </label>
                  <textarea
                    data-testid="continue-audit-focus"
                    value={continueFocus}
                    onChange={(e) => setContinueFocus(e.target.value)}
                    placeholder={i18n.t("newTask.auditFocusPlaceholder")}
                    rows={3}
                    maxLength={2000}
                    style={{ width: "100%", border: "1px solid var(--border)", borderRadius: "6px", padding: "8px 10px", fontSize: "13px", background: "var(--bg-page)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box", resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "6px" }}>
                    {i18n.t("newTask.scanDuration")}
                  </label>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <input
                      data-testid="continue-scan-duration"
                      type="number"
                      min={1}
                      value={continueDuration}
                      onChange={(e) => setContinueDuration(e.target.value)}
                      style={{ width: "100px", height: "40px", border: "1px solid var(--border)", borderRadius: "6px", padding: "0 10px", fontSize: "13px", background: "var(--bg-page)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" }}
                    />
                    <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>{i18n.t("newTask.minutes")}</span>
                  </div>
                </div>
                {continueMut.isError && (
                  <p style={{ color: "var(--brand)", fontSize: "13px", margin: "12px 0 0" }}>
                    {(continueMut.error as Error)?.message ?? String(continueMut.error)}
                  </p>
                )}
              </div>
              <div style={{ padding: "0 24px 24px", display: "flex", gap: "10px" }}>
                <button
                  onClick={() => setContinueDialogOpen(false)}
                  style={{ flex: 1, padding: "10px", background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)", borderRadius: "6px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}
                >
                  {i18n.t("common.cancel")}
                </button>
                <button
                  data-testid="continue-scan-submit"
                  onClick={() => continueMut.mutate()}
                  disabled={continueMut.isPending}
                  style={{ flex: 1, padding: "10px", background: continueMut.isPending ? "var(--bg-disabled)" : "var(--brand)", color: continueMut.isPending ? "var(--text-secondary)" : "var(--btn-primary-text)", border: "none", borderRadius: "6px", fontSize: "13px", fontWeight: 600, cursor: continueMut.isPending ? "not-allowed" : "pointer" }}
                >
                  {continueMut.isPending ? i18n.t("newTask.submitting") : i18n.t("taskDetail.continueSubmit")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Live Log (fused into topbar) */}
        <LiveLog taskId={task.id} taskState={task.state} />
      </div>

      {/* Tab bar */}
      <div
        data-testid="task-detail-tabs"
        style={{
          display: "flex",
          gap: "0",
          background: "var(--bg-card)",
          borderBottom: "1px solid var(--border)",
          padding: "0 40px",
        }}
      >
        {TABS.map((tab) => {
          const to = tab.path ? `/tasks/${task.id}/${tab.path}` : `/tasks/${task.id}`;
          const count = tabCounts[tab.path];
          return (
            <NavLink
              key={tab.path}
              to={to}
              end={tab.path === ""}
              data-testid={`task-detail-tab-${tab.path || "overview"}`}
              style={({ isActive }) => ({
                padding: "14px 20px",
                marginBottom: "-1px",
                textDecoration: "none",
                fontSize: "13px",
                fontWeight: 500,
                color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                borderBottom: isActive ? "2px solid var(--brand)" : "2px solid transparent",
                whiteSpace: "nowrap",
                transition: "color 0.1s",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
              })}
            >
              <span>{i18n.t(tab.labelKey)}</span>
              {count != null && <TabCountBadge count={count} />}
            </NavLink>
          );
        })}
      </div>

      {/* Tab content — gray page with rounded white card(s) inside.
          Overview renders a grid of small cards; other Tabs wrap their
          two-column layout in one big rounded card (all sharing the
          same "card on gray page" visual language). */}
      <div
        data-testid="task-detail-outlet"
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          padding: "20px 40px 32px",
        }}
      >
        <Outlet context={{ task, openContinueDialog } satisfies TaskOutletContext} />
      </div>
    </div>
  );
}

/**
 * Failure banner — shown only when task.state === 'failed'.
 * Displays failure_reason + actions to jump to the log or retry.
 */
function FailureBanner({ task }: { task: Task }) {
  const reason = (task.failure_reason ?? "").trim();
  function expandLog() {
    const el = document.querySelector<HTMLElement>('[data-testid="live-log-expand-btn"]');
    if (el) {
      // Expand if collapsed, then scroll it into view.
      const panel = document.querySelector<HTMLElement>('[data-testid="live-log-stream"]');
      if (!panel) el.click();
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
  return (
    <div
      data-testid="task-failure-banner"
      style={{
        marginTop: "14px",
        display: "flex",
        gap: "12px",
        alignItems: "flex-start",
        padding: "12px 14px",
        background: "var(--bg-error)",
        border: "1px solid rgba(194,40,40,0.28)",
        borderLeft: "3px solid var(--brand)",
        borderRadius: "8px",
      }}
    >
      <Icon
        name="alert-triangle"
        size={18}
        style={{ color: "var(--brand)", marginTop: "1px" }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--brand)",
            marginBottom: "4px",
            lineHeight: 1.3,
          }}
        >
          {i18n.t("taskDetail.failure.title")}
        </div>
        <div
          data-testid="task-failure-reason"
          style={{
            fontSize: "12px",
            color: "var(--text-primary)",
            lineHeight: 1.55,
            wordBreak: "break-word",
            fontFamily: reason ? "'SF Mono', Menlo, Consolas, monospace" : undefined,
          }}
        >
          {reason || i18n.t("taskDetail.failure.noReason")}
        </div>
      </div>
      <button
        data-testid="task-failure-view-log"
        onClick={expandLog}
        style={{
          flexShrink: 0,
          padding: "6px 12px",
          background: "transparent",
          border: "1px solid var(--brand)",
          borderRadius: "6px",
          color: "var(--brand)",
          fontSize: "12px",
          fontWeight: 600,
          cursor: "pointer",
          whiteSpace: "nowrap",
          lineHeight: 1,
        }}
      >
        {i18n.t("taskDetail.failure.viewLog")}
      </button>
    </div>
  );
}

/** Outlet context for task tabs: the task plus the continue-scan opener so
 *  tab-level timeout nudges can raise the same dialog as the header button. */
export interface TaskOutletContext {
  task: Task;
  openContinueDialog: () => void;
}

/**
 * Timeout banner (task-a3d095ad): the scan hit its time budget — tell the user
 * it's not "verification skipped", it's "time ran out", and offer continue-scan.
 */
function TimeoutBanner({ onContinue }: { onContinue: () => void }) {
  return (
    <div
      data-testid="task-timeout-banner"
      style={{
        marginTop: "14px",
        display: "flex",
        gap: "12px",
        alignItems: "flex-start",
        padding: "12px 14px",
        background: "rgba(202, 138, 4, 0.08)",
        border: "1px solid rgba(202, 138, 4, 0.30)",
        borderLeft: "3px solid #ca8a04",
        borderRadius: "8px",
      }}
    >
      <Icon
        name="clock"
        size={18}
        style={{ color: "var(--sev-medium)", marginTop: "1px" }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--sev-medium)",
            marginBottom: "4px",
            lineHeight: 1.3,
          }}
        >
          {i18n.t("taskDetail.timeout.title")}
        </div>
        <div
          style={{
            fontSize: "12px",
            color: "var(--text-primary)",
            lineHeight: 1.55,
          }}
        >
          {i18n.t("taskDetail.timeout.body")}
        </div>
      </div>
      <button
        data-testid="task-timeout-continue"
        onClick={onContinue}
        style={{
          flexShrink: 0,
          padding: "6px 12px",
          background: "transparent",
          border: "1px solid var(--sev-medium)",
          borderRadius: "6px",
          color: "var(--sev-medium)",
          fontSize: "12px",
          fontWeight: 600,
          cursor: "pointer",
          whiteSpace: "nowrap",
          lineHeight: 1,
        }}
      >
        {i18n.t("taskDetail.timeout.continue")}
      </button>
    </div>
  );
}

function MetaItem({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  // Important for midline alignment (fish #10 v3):
  //  - lineHeight 1 on the flex container collapses the line-box so
  //    text's visual glyph center coincides with its flex-item center.
  //  - Text children get wrapped in a span with explicit line-height
  //    so Chinese glyphs render at their natural optical center instead
  //    of floating above the icon's geometric center.
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        lineHeight: 1,
      }}
    >
      <Icon
        name={icon}
        size={14}
        style={{ display: "block", flexShrink: 0 }}
      />
      <span style={{ display: "inline-flex", alignItems: "center" }}>
        {children}
      </span>
    </span>
  );
}

function TabCountBadge({ count }: { count: number }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: "20px",
        height: "18px",
        padding: "0 6px",
        background: "var(--divider)",
        borderRadius: "9px",
        fontSize: "11px",
        fontWeight: 600,
        color: "var(--text-secondary)",
        lineHeight: 1,
      }}
    >
      {count}
    </span>
  );
}
