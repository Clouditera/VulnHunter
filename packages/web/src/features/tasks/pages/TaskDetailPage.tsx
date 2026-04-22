import { useState, useEffect } from "react";
import { useParams, useNavigate, NavLink, Outlet } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Task } from "../../../shared/api/client.js";
import { LiveLog } from "../../live-log/components/LiveLog.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { StatusPill } from "../../../shared/components/StatusPill.js";
import {
  formatDateTime,
  parseRiskScore,
  riskScoreColor,
} from "../../../shared/utils/format.js";

const TABS = [
  { labelKey: "taskDetail.tab.overview", path: "" },
  { labelKey: "taskDetail.tab.findings", path: "findings" },
  { labelKey: "taskDetail.tab.reports", path: "reports" },
  { labelKey: "taskDetail.tab.poc", path: "poc" },
  { labelKey: "taskDetail.tab.workspace", path: "workspace" },
];

function formatDuration(ms: number | null): string {
  if (!ms) return "—";
  const min = Math.round(ms / 60_000);
  return `${min} min`;
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
    refetchInterval: (query) => {
      const task = query.state.data?.task;
      return task?.state === "running" ? 3000 : false;
    },
    enabled: !!taskId,
  });

  // Shared findings query — also used inside OverviewTab/FindingsTab via same cache key.
  const { data: findingsData } = useQuery({
    queryKey: ["findings", taskId],
    queryFn: () => api.findings.list(taskId!),
    enabled: !!taskId,
    refetchInterval: 5000,
  });
  const findingsCount = findingsData?.findings?.length ?? 0;

  const cancelMut = useMutation({
    mutationFn: () => api.tasks.cancel(taskId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["task", taskId] }),
  });
  const restartMut = useMutation({
    mutationFn: () => api.tasks.restart(taskId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["task", taskId] }),
  });

  const task = data?.task as Task | undefined;

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

  const risk = parseRiskScore(task.risk_score);

  const tabCounts: Record<string, number | undefined> = {
    findings: findingsCount > 0 ? findingsCount : undefined,
    // reports / poc counts not yet wired
  };

  return (
    <div data-testid="task-detail-page" style={{ minHeight: "100vh", background: "var(--bg-page)" }}>
      {/* Topbar */}
      <div
        data-testid="task-topbar"
        style={{
          background: "var(--bg-card)",
          borderBottom: "1px solid var(--border)",
          padding: "20px 40px",
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
            marginBottom: "14px",
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
                }}
              >
                {task.project_name}
              </h1>
              <StatusPill state={task.state} />
            </div>

            {/* Meta row: Risk · Duration · Started */}
            <div
              style={{
                display: "flex",
                gap: "20px",
                marginTop: "10px",
                fontSize: "13px",
                color: "var(--text-secondary)",
                flexWrap: "wrap",
              }}
            >
              {risk != null && (
                <MetaItem icon="shield">
                  {i18n.t("taskDetail.meta.risk")}:{" "}
                  <strong style={{ color: riskScoreColor(risk), marginLeft: "4px" }}>
                    {risk.toFixed(1)}/10
                  </strong>
                </MetaItem>
              )}
              <MetaItem icon="clock">
                {i18n.t("taskDetail.meta.duration")}:{" "}
                <strong style={{ color: "var(--text-primary)", marginLeft: "4px" }}>
                  {formatDuration(task.duration_ms)}
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
            {["running", "queued"].includes(task.state) && (
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
                onMouseEnter={(e) => (e.currentTarget.style.background = "#b91c1c")}
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
          </div>
        </div>

        {/* Failure banner (when state=failed) */}
        {task.state === "failed" && <FailureBanner task={task} />}

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

      {/* Tab content */}
      <div style={{ padding: "28px 40px 40px" }}>
        <Outlet context={{ task }} />
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
        border: "1px solid rgba(220,38,38,0.28)",
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

function MetaItem({ icon, children }: { icon: "shield" | "clock" | "calendar"; children: React.ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
      <Icon name={icon} size={14} />
      {children}
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
