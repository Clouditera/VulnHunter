import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Task, type FindingReviewStatus } from "../../../shared/api/client.js";
import { NewTaskModal } from "../components/NewTaskModal.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { useSystemStatus } from "../../auth/hooks/useSystemStatus.js";
import { StatusPill } from "../../../shared/components/StatusPill.js";
import { SeverityBadges } from "../../../shared/components/SeverityBadges.js";
import {
  formatDateTime,
} from "../../../shared/utils/format.js";

function formatDuration(ms: number | null): string {
  if (!ms) return "—";
  const min = Math.round(ms / 60_000);
  return `${min} min`;
}

/**
 * Per-row findings cell:
 *  - running/queued:   “scanning…” (muted italic)
 *  - completed + any:  sev-mini badges (2H 5M 3L 2I)
 *  - completed + zero: “none”
 *  - failed/cancelled: —
 */
function renderFindingsCell(task: Task): JSX.Element {
  if (task.state === "running" || task.state === "queued" || task.state === "preparing") {
    return (
      <span style={{ fontStyle: "italic", opacity: 0.75 }}>
        {i18n.t("tasks.findings.scanning")}
      </span>
    );
  }
  if (task.state !== "completed") {
    return <span>—</span>;
  }
  const counts = task.severity_counts ?? { high: 0, medium: 0, low: 0, info: 0 };
  const total = counts.high + counts.medium + counts.low + counts.info;
  if (total === 0) {
    return (
      <span style={{ opacity: 0.75 }}>{i18n.t("tasks.findings.none")}</span>
    );
  }
  return <SeverityBadges counts={counts} />;
}

type SortMode = "newest" | "oldest" | "name";

export function TasksListPage() {
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [sortBy, setSortBy] = useState<SortMode>("newest");
  const [showModal, setShowModal] = useState(false);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const reviewStatusParam = searchParams.get("review_status") as FindingReviewStatus | null;
  const qc = useQueryClient();
  const [, forceUpdate] = useState(0);
  useEffect(() => i18n.onChange(() => forceUpdate((n) => n + 1)), []);

  const { data: status } = useSystemStatus();
  const isAdmin = status?.user?.role === "admin";
  const [selectedUserId, setSelectedUserId] = useState("");
  const { data: usersData } = useQuery({
    queryKey: ["users", "tasks-filter"],
    queryFn: () => api.users.list(),
    enabled: isAdmin,
  });

  const { data, isLoading } = useQuery({
    queryKey: ["tasks", stateFilter, reviewStatusParam, selectedUserId],
    queryFn: () => api.tasks.list({
      state: stateFilter === "all" ? undefined : stateFilter,
      reviewStatus: reviewStatusParam ?? undefined,
      userId: selectedUserId || undefined,
    }),
    // Server SSE (`task_state`) invalidates ["tasks"] on every state change.
  });

  const cancelMut = useMutation({
    mutationFn: (id: string) => api.tasks.cancel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.tasks.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
    onError: () => {
      alert(i18n.t("tasks.delete.error"));
    },
  });

  const rawTasks = data?.tasks ?? [];
  const filters = ["all", "running", "completed", "failed", "queued"] as const;

  // Apply search (case-insensitive substring match on project_name + id).
  const q = searchQuery.trim().toLowerCase();
  const filteredTasks = q
    ? rawTasks.filter(
        (t) =>
          (t.display_name ?? "").toLowerCase().includes(q) ||
          (t.project_name ?? "").toLowerCase().includes(q) ||
          t.id.toLowerCase().includes(q),
      )
    : rawTasks;

  // Sort. Backend returns newest-first already for "newest"; we re-sort
  // client-side so that oldest/name modes work identically.
  const tasks = [...filteredTasks].sort((a, b) => {
    if (sortBy === "name") {
      return ((a.display_name?.trim() || a.project_name) ?? "").localeCompare((b.display_name?.trim() || b.project_name) ?? "");
    }
    const tA = Date.parse(a.created_at);
    const tB = Date.parse(b.created_at);
    return sortBy === "oldest" ? tA - tB : tB - tA;
  });

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

      {/* Search + Sort row */}
      <div
        style={{
          display: "flex",
          gap: "10px",
          alignItems: "center",
          marginBottom: "12px",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            position: "relative",
            flex: 1,
            minWidth: "200px",
            maxWidth: "360px",
          }}
        >
          <Icon
            name="search"
            size={14}
            style={{
              position: "absolute",
              left: "10px",
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-secondary)",
              pointerEvents: "none",
            }}
          />
          <input
            type="search"
            data-testid="tasks-search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={i18n.t("tasks.searchPlaceholder")}
            style={{
              width: "100%",
              height: "34px",
              padding: "0 10px 0 30px",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              fontSize: "13px",
              background: "var(--bg-card)",
              color: "var(--text-primary)",
              outline: "none",
            }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <label
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--text-secondary)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            {i18n.t("tasks.sort.label")}
          </label>
          <select
            data-testid="tasks-sort-select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortMode)}
            style={{
              height: "34px",
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              fontSize: "12px",
              background: "var(--bg-card)",
              color: "var(--text-primary)",
              cursor: "pointer",
              outline: "none",
            }}
          >
            <option value="newest">{i18n.t("tasks.sort.newest")}</option>
            <option value="oldest">{i18n.t("tasks.sort.oldest")}</option>
            <option value="name">{i18n.t("tasks.sort.name")}</option>
          </select>
        </div>
        {isAdmin && (
          <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {i18n.t("filters.user")}
            <select data-testid="tasks-user-filter" value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} style={{ height: "34px", padding: "0 10px", border: "1px solid var(--border)", borderRadius: "6px", fontSize: "12px", background: "var(--bg-card)", color: "var(--text-primary)", cursor: "pointer", outline: "none" }}>
              <option value="">{i18n.t("filters.allUsers")}</option>
              {(usersData?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
            </select>
          </label>
        )}
        <span
          data-testid="tasks-count"
          style={{
            fontSize: "12px",
            color: "var(--text-secondary)",
            marginLeft: "auto",
          }}
        >
          {i18n
            .t("tasks.countFormat")
            .replace("{count}", String(tasks.length))}
        </span>
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

      {/* Review status filter pill */}
      {reviewStatusParam && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "4px 10px 4px 12px", borderRadius: 999, fontSize: 12,
              background: "var(--review-pending-bg)", border: "1px solid var(--border)",
              color: "var(--text-primary)",
            }}
          >
            {i18n.t("review.section.title")}：{i18n.t(`review.status.${reviewStatusParam}`)}
            <button
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete("review_status");
                setSearchParams(next);
              }}
              style={{
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--text-secondary)", fontSize: 12, padding: 0, fontFamily: "inherit",
              }}
            >
              ✕
            </button>
          </span>
        </div>
      )}

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
                  "tasks.col.findings",
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
                  colSpan={7}
                  style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary)" }}
                >
                  {i18n.t("tasks.loading")}
                </td>
              </tr>
            ) : tasks.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  style={{ padding: "48px", textAlign: "center", color: "var(--text-secondary)" }}
                >
                  {i18n.t("tasks.empty")}
                </td>
              </tr>
            ) : (
              tasks.map((task: Task) => {
                const title = task.display_name?.trim() || task.project_name;
                const subtitle = task.display_name?.trim() ? task.project_name : null;
                return (
                  <tr
                    key={task.id}
                    data-testid="task-row"
                    data-status={task.state}
                    onClick={() => navigate(
                      reviewStatusParam
                        ? `/tasks/${task.id}/findings?review=${reviewStatusParam}`
                        : `/tasks/${task.id}`,
                    )}
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
                        <span>{title}</span>
                      </div>
                      {subtitle ? <div style={{ marginLeft: 22, marginTop: 3, fontSize: 11, color: "var(--text-secondary)", fontWeight: 400 }}>{subtitle}</div> : null}
                    </td>
                    <td style={{ padding: "14px 20px" }}>
                      <StatusPill state={task.state} />
                    </td>
                    <td
                      data-testid="task-findings-cell"
                      style={{ padding: "14px 20px", color: "var(--text-secondary)", fontSize: "12px" }}
                    >
                      {renderFindingsCell(task)}
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
                      <div style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
                        {["running", "queued", "preparing"].includes(task.state) && (
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
                              lineHeight: 1,
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
                        {!["running", "queued", "preparing"].includes(task.state) && (
                          <button
                            data-testid="task-delete-btn"
                            aria-label={i18n.t("tasks.delete")}
                            title={i18n.t("tasks.delete")}
                            disabled={deleteMut.isPending}
                            onClick={() => {
                              const msg = i18n
                                .t("tasks.delete.confirm")
                                .replace("{name}", title);
                              if (window.confirm(msg)) deleteMut.mutate(task.id);
                            }}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              width: "28px",
                              height: "28px",
                              border: "1px solid var(--border)",
                              borderRadius: "6px",
                              background: "transparent",
                              cursor: "pointer",
                              color: "var(--text-secondary)",
                              transition: "all 0.15s",
                              padding: 0,
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
                            <Icon name="trash" size={14} />
                          </button>
                        )}
                      </div>
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
