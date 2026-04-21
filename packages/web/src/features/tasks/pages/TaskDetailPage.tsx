import { useParams, useNavigate, NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Task } from "../../../shared/api/client.js";
import { LiveLog } from "../../live-log/components/LiveLog.js";

const TABS = [
  { label: "Overview", path: "" },
  { label: "Findings", path: "findings" },
  { label: "Reports", path: "reports" },
  { label: "POC/EXP", path: "poc" },
  { label: "Workspace", path: "workspace" },
];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(ms: number | null): string {
  if (!ms) return "—";
  const min = Math.round(ms / 60_000);
  return `${min} min`;
}

const STATE_COLORS: Record<string, string> = {
  running: "var(--status-running)",
  completed: "var(--status-completed)",
  failed: "var(--status-failed)",
  cancelled: "var(--status-cancelled)",
  queued: "var(--status-queued)",
  paused: "var(--status-paused)",
};

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.tasks.get(taskId!),
    refetchInterval: (query) => {
      const task = query.state.data?.task;
      return task?.state === "running" ? 3000 : false;
    },
    enabled: !!taskId,
  });

  const task = data?.task as Task | undefined;

  if (isLoading) {
    return <div style={{ padding: "40px", color: "var(--text-secondary)" }}>Loading…</div>;
  }

  if (!task) {
    return <div style={{ padding: "40px", color: "var(--brand)" }}>Task not found.</div>;
  }

  const stateColor = STATE_COLORS[task.state] ?? "var(--status-cancelled)";

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
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-secondary)",
            fontSize: "13px",
            padding: "0 0 12px",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          ← Back to Tasks
        </button>

        {/* Title + meta */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h1
              data-testid="task-project-name"
              style={{ fontSize: "22px", fontWeight: 700, margin: "0 0 8px" }}
            >
              {task.project_name}
            </h1>
            <div style={{ display: "flex", gap: "16px", fontSize: "12px", color: "var(--text-secondary)", flexWrap: "wrap" }}>
              <span
                data-testid="task-status-badge"
                data-status={task.state}
                style={{
                  color: stateColor,
                  fontWeight: 600,
                  textTransform: "capitalize",
                }}
              >
                ● {task.state}
              </span>
              {task.risk_score != null && (
                <span>Risk: <strong>{parseFloat(String(task.risk_score)).toFixed(1)}/10</strong></span>
              )}
              <span>Duration: <strong>{formatDuration(task.duration_ms)}</strong></span>
              <span>Started: <strong>{formatDate(task.started_at)}</strong></span>
            </div>
          </div>
        </div>

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
          const to = tab.path
            ? `/tasks/${task.id}/${tab.path}`
            : `/tasks/${task.id}`;
          return (
            <NavLink
              key={tab.path}
              to={to}
              end={tab.path === ""}
              data-testid={`task-detail-tab-${tab.path || "overview"}`}
              style={({ isActive }) => ({
                padding: "10px 16px",
                textDecoration: "none",
                fontSize: "13px",
                fontWeight: isActive ? 600 : 400,
                color: isActive ? "var(--brand)" : "var(--text-secondary)",
                borderBottom: isActive ? "2px solid var(--brand)" : "2px solid transparent",
                whiteSpace: "nowrap",
              })}
            >
              {tab.label}
            </NavLink>
          );
        })}
      </div>

      {/* Tab content */}
      <div style={{ padding: "32px 40px" }}>
        <Outlet context={{ task }} />
      </div>
    </div>
  );
}
