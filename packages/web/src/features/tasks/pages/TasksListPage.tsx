import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Task } from "../../../shared/api/client.js";
import { NewTaskModal } from "../components/NewTaskModal.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { StatusPill } from "../../../shared/components/StatusPill.js";
import {
  formatDateTime,
  parseRiskScore,
  riskScoreColor,
} from "../../../shared/utils/format.js";

function formatDuration(ms: number | null): string {
  if (!ms) return "—";
  const min = Math.round(ms / 60_000);
  return `${min} min`;
}

export function TasksListPage() {
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [showModal, setShowModal] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [, forceUpdate] = useState(0);
  useEffect(() => i18n.onChange(() => forceUpdate((n) => n + 1)), []);

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
  const filters = ["all", "running", "completed", "failed", "queued"] as const;

  return (
    <div data-testid="tasks-page" style={{ padding: "32px 40px 48px" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "20px",
        }}
      >
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          {i18n.t("tasks.title")}
        </h1>
        <button
          data-testid="new-task-btn"
          onClick={() => setShowModal(true)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "9px 16px",
            background: "var(--brand)",
            color: "var(--btn-primary-text)",
            border: "none",
            borderRadius: "6px",
            fontSize: "13px",
            fontWeight: 600,
            cursor: "pointer",
            boxShadow: "0 1px 2px rgba(220,38,38,0.2)",
          }}
        >
          <Icon name="plus" size={15} strokeWidth={2.5} />
          {i18n.t("tasks.newTask")}
        </button>
      </div>

      {/* Filter pills */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
        {filters.map((s) => (
          <button
            key={s}
            data-testid={`filter-${s}`}
            onClick={() => setStateFilter(s)}
            style={{
              padding: "6px 14px",
              border: `1px solid ${stateFilter === s ? "var(--brand)" : "var(--border)"}`,
              borderRadius: "999px",
              background: stateFilter === s ? "var(--bg-active-filter)" : "var(--bg-card)",
              color: stateFilter === s ? "var(--brand)" : "var(--text-secondary)",
              fontSize: "12px",
              fontWeight: 500,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {s === "all" ? i18n.t("tasks.filterAll") : i18n.t(`tasks.status.${s}`)}
          </button>
        ))}
      </div>

      {/* Table */}
      <div
        style={{
          background: "var(--bg-card)",
          borderRadius: "10px",
          overflow: "hidden",
          border: "1px solid var(--border)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--divider)" }}>
              {(
                [
                  "tasks.col.project",
                  "tasks.col.status",
                  "tasks.col.riskScore",
                  "tasks.col.duration",
                  "tasks.col.created",
                  "tasks.col.actions",
                ] as const
              ).map((key) => (
                <th
                  key={key}
                  style={{
                    padding: "12px 20px",
                    textAlign: "left",
                    fontWeight: 600,
                    fontSize: "11px",
                    color: "var(--text-secondary)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  {i18n.t(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td
                  colSpan={6}
                  style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary)" }}
                >
                  {i18n.t("tasks.loading")}
                </td>
              </tr>
            ) : tasks.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  style={{ padding: "48px", textAlign: "center", color: "var(--text-secondary)" }}
                >
                  {i18n.t("tasks.empty")}
                </td>
              </tr>
            ) : (
              tasks.map((task: Task) => {
                const risk = parseRiskScore(task.risk_score);
                return (
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
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                  >
                    <td style={{ padding: "14px 20px", fontWeight: 600, color: "var(--text-primary)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Icon
                          name={task.source_type === "git" ? "git-branch" : "upload"}
                          size={14}
                          style={{ color: "var(--text-secondary)" }}
                        />
                        <span>{task.project_name}</span>
                      </div>
                    </td>
                    <td style={{ padding: "14px 20px" }}>
                      <StatusPill state={task.state} />
                    </td>
                    <td
                      style={{
                        padding: "14px 20px",
                        fontWeight: 600,
                        color: risk != null ? riskScoreColor(risk) : "var(--text-secondary)",
                      }}
                    >
                      {risk != null ? risk.toFixed(1) : "—"}
                    </td>
                    <td
                      style={{ padding: "14px 20px", color: "var(--text-secondary)", fontSize: "12px" }}
                    >
                      {formatDuration(task.duration_ms)}
                    </td>
                    <td
                      style={{ padding: "14px 20px", color: "var(--text-secondary)", fontSize: "12px" }}
                    >
                      {formatDateTime(task.created_at)}
                    </td>
                    <td style={{ padding: "14px 20px" }} onClick={(e) => e.stopPropagation()}>
                      {["running", "queued"].includes(task.state) && (
                        <button
                          data-testid="task-cancel-btn"
                          onClick={() => cancelMut.mutate(task.id)}
                          style={{
                            padding: "5px 12px",
                            border: "1px solid var(--border)",
                            borderRadius: "6px",
                            background: "transparent",
                            fontSize: "12px",
                            cursor: "pointer",
                            color: "var(--text-secondary)",
                            transition: "all 0.15s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.borderColor = "var(--brand)";
                            e.currentTarget.style.color = "var(--brand)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.color = "var(--text-secondary)";
                          }}
                        >
                          {i18n.t("tasks.cancel")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
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
