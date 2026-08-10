import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Task, type FindingReviewStatus } from "../../../shared/api/client.js";
import { NewTaskModal } from "../components/NewTaskModal.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { FilterDropdown } from "../../../shared/components/FilterDropdown.js";
import { useSystemStatus } from "../../auth/hooks/useSystemStatus.js";
import { StatusPill } from "../../../shared/components/StatusPill.js";
import { effectiveTaskState, isTaskTimedOut } from "../task-timeout.js";
import { SeverityBadges } from "../../../shared/components/SeverityBadges.js";
import { truncateTaskName } from "../task-name.js";
import { confirm } from "../../../shared/confirm/confirm.js";
import { toast } from "../../../shared/toast/toast.js";
import {
  formatDateTime,
  formatDurationMinutes,
  toDurationMs,
} from "../../../shared/utils/format.js";

/**
 * Per-row findings cell:
 *  - running/queued:   “scanning…” (muted italic)
 *  - completed + any:  sev-mini badges (2H 5M 3L 2I)
 *  - completed + zero: “none”
 *  - failed/cancelled: —
 */
function renderCreatorCell(task: Task): JSX.Element {
  const creator = task.creator;
  if (!creator) return <span>—</span>;
  return (
    <span title={creator.email || undefined} style={{ fontWeight: 500, color: "var(--text-primary)" }}>
      {creator.display_name || creator.email || "Unknown"}
    </span>
  );
}

function renderFindingsCell(task: Task): JSX.Element {
  if (task.state === "running" || task.state === "queued" || task.state === "preparing") {
    return (
      <span style={{ fontStyle: "italic", opacity: 0.75 }}>
        {i18n.t("tasks.findings.scanning")}
      </span>
    );
  }
  // Show counts whenever findings exist — including failed/cancelled tasks (fish).
  const counts = task.severity_counts ?? { high: 0, medium: 0, low: 0, info: 0 };
  const total = counts.high + counts.medium + counts.low + counts.info;
  if (total === 0) {
    if (task.state === "completed") {
      return (
        <span style={{ opacity: 0.75 }}>{i18n.t("tasks.findings.none")}</span>
      );
    }
    return <span>—</span>;
  }
  return <SeverityBadges counts={counts} />;
}

type SortMode = "newest" | "oldest" | "name";
const PAGE_SIZE_KEY = "vh.tasks.pageSize";
const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
function loadPageSize(): number {
  const n = Number(window.localStorage.getItem(PAGE_SIZE_KEY) ?? 10);
  return PAGE_SIZE_OPTIONS.includes(n as (typeof PAGE_SIZE_OPTIONS)[number]) ? n : 10;
}

export function TasksListPage() {
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [searchDebounced, setSearchDebounced] = useState("");
  const [sortBy, setSortBy] = useState<SortMode>("newest");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(loadPageSize);
  const [gotoPage, setGotoPage] = useState("");
  const [showModal, setShowModal] = useState(false);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const reviewStatusParam = searchParams.get("review_status") as FindingReviewStatus | null;
  const qc = useQueryClient();
  const [, forceUpdate] = useState(0);
  useEffect(() => i18n.onChange(() => forceUpdate((n) => n + 1)), []);

  // Debounce search → server q
  useEffect(() => {
    const tmr = window.setTimeout(() => setSearchDebounced(searchQuery.trim()), 300);
    return () => window.clearTimeout(tmr);
  }, [searchQuery]);

  const { data: status } = useSystemStatus();
  const isAdmin = status?.user?.role === "admin";
  const [selectedUserId, setSelectedUserId] = useState("");
  const { data: usersData } = useQuery({
    queryKey: ["users", "tasks-filter"],
    queryFn: () => api.users.list(),
    enabled: isAdmin,
  });

  const { data, isLoading } = useQuery({
    queryKey: ["tasks", stateFilter, reviewStatusParam, selectedUserId, page, pageSize, searchDebounced, sortBy],
    queryFn: () => api.tasks.list({
      state: stateFilter === "all" ? undefined : stateFilter === "timed_out" ? "completed" : stateFilter,
      reviewStatus: reviewStatusParam ?? undefined,
      userId: selectedUserId || undefined,
      paginate: true,
      page,
      pageSize,
      q: searchDebounced || undefined,
      sort: sortBy,
    }),
    // Server SSE (`task_state`) invalidates ["tasks"] on every state change.
  });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, data?.total_pages ?? (Math.ceil(total / pageSize) || 1));

  // Reset to page 1 when filters / search / sort change
  useEffect(() => {
    setPage(1);
  }, [stateFilter, reviewStatusParam, selectedUserId, searchDebounced, sortBy, pageSize]);

  // Clamp page if deletion emptied the current page
  useEffect(() => {
    if (!isLoading && page > totalPages) setPage(totalPages);
  }, [isLoading, page, totalPages]);

  const cancelMut = useMutation({
    mutationFn: (id: string) => api.tasks.cancel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.tasks.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
    onError: () => {
      toast.error(i18n.t("tasks.delete.error"));
    },
  });

  const tasks = data?.tasks ?? [];
  // "timed_out" filter: server doesn't know the virtual state yet — fetch the
  // completed page and filter rows client-side (task-a3d095ad front-half).
  // TODO(backend): once the list endpoint accepts state=timed_out, drop the
  // client filter so totals/pagination are server-accurate.
  const visibleTasks = stateFilter === "timed_out" ? tasks.filter(isTaskTimedOut) : tasks;
  const filters = ["all", "running", "completed", "timed_out", "failed", "queued"] as const;

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
            boxShadow: "0 1px 2px rgba(194,40,40,0.2)",
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
        <FilterDropdown
          testid="tasks-sort-select"
          value={sortBy}
          onChange={(v) => setSortBy(v as SortMode)}
          options={[
            { value: "newest", label: i18n.t("tasks.sort.newest") },
            { value: "oldest", label: i18n.t("tasks.sort.oldest") },
            { value: "name", label: i18n.t("tasks.sort.name") },
          ]}
        />
        {isAdmin ? (
          <FilterDropdown
            testid="tasks-user-filter"
            value={selectedUserId}
            onChange={setSelectedUserId}
            width={140}
            options={[
              { value: "", label: i18n.t("filters.allUsers") },
              ...(usersData?.users ?? []).map((u) => ({
                value: u.id,
                label: u.display_name || u.email,
              })),
            ]}
          />
        ) : null}
        <FilterDropdown
          testid="tasks-page-size"
          value={String(pageSize)}
          onChange={(v) => {
            const n = Number(v);
            setPageSize(n);
            window.localStorage.setItem(PAGE_SIZE_KEY, String(n));
            setPage(1);
          }}
          options={PAGE_SIZE_OPTIONS.map((n) => ({
            value: String(n),
            label: i18n.t("tasks.pager.pageSize").replace("{n}", String(n)),
          }))}
        />
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
            .replace("{count}", String(total || tasks.length))}
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
        data-testid="tasks-table-scroll"
        style={{
          background: "var(--bg-card)",
          borderRadius: "10px",
          overflowX: "auto",
          overflowY: "hidden",
          border: "1px solid var(--border)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <table
          style={{
            width: "100%",
            minWidth: 860,
            borderCollapse: "collapse",
            fontSize: "13px",
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid var(--divider)" }}>
              {(
                [
                  "tasks.col.project",
                  "tasks.col.status",
                  "tasks.col.findings",
                  ...(isAdmin ? (["tasks.col.creator"] as const) : []),
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
                  colSpan={isAdmin ? 7 : 6}
                  style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary)" }}
                >
                  {i18n.t("tasks.loading")}
                </td>
              </tr>
            ) : visibleTasks.length === 0 ? (
              <tr>
                <td
                  colSpan={isAdmin ? 7 : 6}
                  style={{ padding: "48px", textAlign: "center", color: "var(--text-secondary)" }}
                >
                  {i18n.t("tasks.empty")}
                </td>
              </tr>
            ) : (
              visibleTasks.map((task: Task) => {
                const title = task.display_name?.trim() || task.project_name;
                const displayedTitle = truncateTaskName(title);
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
                        <span
                          title={displayedTitle.truncated ? title : undefined}
                          aria-label={displayedTitle.truncated ? title : undefined}
                          tabIndex={displayedTitle.truncated ? 0 : undefined}
                          style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        >
                          {displayedTitle.text}
                        </span>
                      </div>
                      {subtitle ? <div style={{ marginLeft: 22, marginTop: 3, fontSize: 11, color: "var(--text-secondary)", fontWeight: 400 }}>{subtitle}</div> : null}
                    </td>
                    <td style={{ padding: "14px 20px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                        <StatusPill state={effectiveTaskState(task)} />
                        {task.sandbox_queue?.waiting ? (
                          <span
                            data-testid="task-queue-badge"
                            title={task.sandbox_queue.reason === "quota"
                              ? i18n.t("tasks.queue.quota")
                              : i18n.t("tasks.queue.capacity")}
                            style={{
                              fontSize: "11px",
                              fontWeight: 650,
                              padding: "2px 7px",
                              borderRadius: "999px",
                              background: "rgba(180,83,9,0.12)",
                              color: "var(--sev-medium)",
                              border: "1px solid rgba(180,83,9,0.3)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {i18n.t("tasks.queue.badge")}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td
                      data-testid="task-findings-cell"
                      style={{ padding: "14px 20px", color: "var(--text-secondary)", fontSize: "12px" }}
                    >
                      {renderFindingsCell(task)}
                    </td>
                    {isAdmin ? (
                      <td
                        data-testid="task-creator-cell"
                        style={{ padding: "14px 20px", color: "var(--text-secondary)", fontSize: "12px" }}
                      >
                        {renderCreatorCell(task)}
                      </td>
                    ) : null}
                    <td
                      style={{ padding: "14px 20px", color: "var(--text-secondary)", fontSize: "12px" }}
                    >
                      {formatDurationMinutes(
                        (() => {
                          const total = toDurationMs(task.total_duration_ms);
                          if (total != null && total > 0) return total;
                          return toDurationMs(task.duration_ms);
                        })(),
                      )}
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
                              void confirm({ message: msg, danger: true }).then((confirmed) => {
                                if (confirmed) deleteMut.mutate(task.id);
                              });
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

      {/* Pagination */}
      {total > 0 ? (
        <div
          data-testid="tasks-pagination"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            flexWrap: "wrap",
            fontSize: 13,
            color: "var(--text-secondary)",
          }}
        >
          <span data-testid="tasks-total">
            {i18n.t("tasks.pager.total").replace("{n}", String(total))}
          </span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span>
            {i18n.t("tasks.pager.page").replace("{n}", `${page}/${totalPages}`)}
          </span>
          <div style={{ display: "flex", gap: 4, marginLeft: 8 }}>
            {([
              ["first", 1, page <= 1, i18n.t("tasks.pager.first")],
              ["prev", Math.max(1, page - 1), page <= 1, i18n.t("tasks.pager.prev")],
            ] as const).map(([key, target, disabled, label]) => (
              <button
                key={key}
                type="button"
                data-testid={`tasks-page-${key}`}
                disabled={disabled}
                onClick={() => setPage(target)}
                style={{
                  height: 30, padding: "0 10px", borderRadius: 6,
                  border: "1px solid var(--border)", background: "var(--bg-card)",
                  color: "var(--text-primary)", cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.45 : 1, fontSize: 12, fontWeight: 600,
                }}
              >
                {label}
              </button>
            ))}
            {/* page window ±2 */}
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((n) => n === 1 || n === totalPages || Math.abs(n - page) <= 2)
              .reduce<number[]>((acc, n, idx, arr) => {
                if (idx > 0 && n - arr[idx - 1] > 1) acc.push(-1);
                acc.push(n);
                return acc;
              }, [])
              .map((n, i) =>
                n < 0 ? (
                  <span key={`e${i}`} style={{ padding: "0 4px" }}>…</span>
                ) : (
                  <button
                    key={n}
                    type="button"
                    data-testid={`tasks-page-${n}`}
                    onClick={() => setPage(n)}
                    style={{
                      height: 30, minWidth: 30, padding: "0 8px", borderRadius: 6,
                      border: n === page ? "1px solid var(--brand)" : "1px solid var(--border)",
                      background: n === page ? "var(--bg-active-filter)" : "var(--bg-card)",
                      color: n === page ? "var(--brand)" : "var(--text-primary)",
                      cursor: "pointer", fontSize: 12, fontWeight: 600,
                    }}
                  >
                    {n}
                  </button>
                ),
              )}
            {([
              ["next", Math.min(totalPages, page + 1), page >= totalPages, i18n.t("tasks.pager.next")],
              ["last", totalPages, page >= totalPages, i18n.t("tasks.pager.last")],
            ] as const).map(([key, target, disabled, label]) => (
              <button
                key={key}
                type="button"
                data-testid={`tasks-page-${key}`}
                disabled={disabled}
                onClick={() => setPage(target)}
                style={{
                  height: 30, padding: "0 10px", borderRadius: 6,
                  border: "1px solid var(--border)", background: "var(--bg-card)",
                  color: "var(--text-primary)", cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.45 : 1, fontSize: 12, fontWeight: 600,
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <form
            style={{ display: "inline-flex", gap: 6, alignItems: "center", marginLeft: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              const n = Math.trunc(Number(gotoPage));
              if (Number.isFinite(n) && n >= 1 && n <= totalPages) setPage(n);
              setGotoPage("");
            }}
          >
            <input
              data-testid="tasks-page-goto"
              value={gotoPage}
              onChange={(e) => setGotoPage(e.target.value)}
              placeholder={String(page)}
              style={{
                width: 48, height: 30, border: "1px solid var(--border)", borderRadius: 6,
                padding: "0 8px", background: "var(--bg-page)", color: "var(--text-primary)",
                fontSize: 12, textAlign: "center",
              }}
            />
            <button
              type="submit"
              data-testid="tasks-page-goto-btn"
              style={{
                height: 30, padding: "0 10px", borderRadius: 6, border: "1px solid var(--border)",
                background: "var(--bg-card)", color: "var(--text-primary)", cursor: "pointer",
                fontSize: 12, fontWeight: 600,
              }}
            >
              {i18n.t("tasks.pager.goto")}
            </button>
          </form>
        </div>
      ) : null}


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
