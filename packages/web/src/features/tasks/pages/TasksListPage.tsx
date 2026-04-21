import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Task } from "../../../shared/api/client.js";
import { NewTaskModal } from "../components/NewTaskModal.js";

const STATE_COLORS: Record<string, string> = {
  running: "var(--status-running)",
  completed: "var(--status-completed)",
  failed: "var(--status-failed)",
  cancelled: "var(--status-cancelled)",
  queued: "var(--status-queued)",
  paused: "var(--status-paused)",
};

function StateBadge({ state }: { state: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "2px 8px",
        borderRadius: "12px",
        fontSize: "11px",
        fontWeight: 600,
        background: STATE_COLORS[state] + "20",
        color: STATE_COLORS[state],
        textTransform: "capitalize",
      }}
    >
      {state === "running" && (
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: STATE_COLORS[state],
            animation: "pulse 1.5s infinite",
          }}
        />
      )}
      {state}
    </span>
  );
}

function formatDuration(ms: number | null): string {
  if (!ms) return "—";
  const min = Math.round(ms / 60_000);
  return `${min} min`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TasksListPage() {
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [showModal, setShowModal] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["tasks", stateFilter],
    queryFn: () => api.tasks.list(stateFilter === "all" ? undefined : stateFilter),
    refetchInterval: 5000,
  });

  const cancelMut = useMutation({
    mutationFn: (id: string) => api.tasks.cancel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const tasks = data?.tasks ?? [];

  return (
    <div data-testid="tasks-page" style={{ padding: "40px" }}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: 0 }}>Tasks</h1>
        <button
          data-testid="new-task-btn"
          onClick={() => setShowModal(true)}
          style={{
            padding: "8px 16px",
            background: "var(--brand)",
            color: "var(--btn-primary-text)",
            border: "none",
            borderRadius: "6px",
            fontSize: "13px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + New Task
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "20px" }}>
        {["all", "running", "completed", "failed", "queued"].map((s) => (
          <button
            key={s}
            data-testid={`filter-${s}`}
            onClick={() => setStateFilter(s)}
            style={{
              padding: "5px 12px",
              border: `1px solid ${stateFilter === s ? "var(--brand)" : "var(--border)"}`,
              borderRadius: "6px",
              background: stateFilter === s ? "var(--bg-active-filter)" : "transparent",
              color: stateFilter === s ? "var(--brand)" : "var(--text-secondary)",
              fontSize: "12px",
              fontWeight: 500,
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Table */}
      <div style={{ background: "var(--bg-card)", borderRadius: "10px", overflow: "hidden", border: "1px solid var(--border)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-page)" }}>
              {["Project", "Status", "Risk Score", "Duration", "Created", "Actions"].map((h) => (
                <th
                  key={h}
                  style={{
                    padding: "10px 16px",
                    textAlign: "left",
                    fontWeight: 600,
                    fontSize: "11px",
                    color: "var(--text-secondary)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary)" }}>
                  Loading…
                </td>
              </tr>
            ) : tasks.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: "48px", textAlign: "center", color: "var(--text-secondary)" }}>
                  No tasks yet. Click "+ New Task" to get started.
                </td>
              </tr>
            ) : (
              tasks.map((task: Task) => (
                <tr
                  key={task.id}
                  data-testid="task-row"
                  data-status={task.state}
                  onClick={() => navigate(`/tasks/${task.id}`)}
                  style={{
                    borderBottom: "1px solid var(--divider)",
                    cursor: "pointer",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-page)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                >
                  <td style={{ padding: "12px 16px", fontWeight: 500 }}>
                    {task.project_name}
                    <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }}>
                      {task.source_type === "git" ? "Git" : "Upload"}
                    </div>
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    <StateBadge state={task.state} />
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    {task.risk_score != null ? (
                      <span
                        style={{
                          fontWeight: 700,
                          color: task.risk_score >= 7 ? "var(--sev-high)" : task.risk_score >= 4 ? "var(--sev-medium)" : "var(--status-completed)",
                        }}
                      >
                        {task.risk_score.toFixed(1)}
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-secondary)" }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: "12px 16px", color: "var(--text-secondary)" }}>
                    {formatDuration(task.duration_ms)}
                  </td>
                  <td style={{ padding: "12px 16px", color: "var(--text-secondary)" }}>
                    {formatDate(task.created_at)}
                  </td>
                  <td
                    style={{ padding: "12px 16px" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {["running", "queued"].includes(task.state) && (
                      <button
                        data-testid="task-cancel-btn"
                        onClick={() => cancelMut.mutate(task.id)}
                        style={{
                          padding: "4px 10px",
                          border: "1px solid var(--border)",
                          borderRadius: "4px",
                          background: "transparent",
                          fontSize: "11px",
                          cursor: "pointer",
                          color: "var(--text-secondary)",
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      {showModal && (
        <NewTaskModal
          onClose={() => setShowModal(false)}
          onCreated={() => {
            setShowModal(false);
            qc.invalidateQueries({ queryKey: ["tasks"] });
          }}
        />
      )}
    </div>
  );
}
