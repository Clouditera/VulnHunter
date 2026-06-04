import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { useSystemStatus } from "../../auth/hooks/useSystemStatus.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon, type IconName } from "../../../shared/components/Icon.js";
import { StatusPill } from "../../../shared/components/StatusPill.js";
import {
  formatRelativeTime,
  parseRiskScore,
  riskScoreColor,
} from "../../../shared/utils/format.js";

const SEV_COLORS = {
  high: "var(--sev-high)",
  medium: "var(--sev-medium)",
  low: "var(--sev-low)",
  info: "var(--sev-info)",
};

// Distinct palette for vulnerability type bars — rotates through 5 hues.
const VULN_TYPE_BAR_COLORS = ["#2563eb", "#7c3aed", "#dc2626", "#ea580c", "#0891b2"];

function StatCard({
  label,
  value,
  sub,
  icon,
  iconColor,
  iconBg,
  testid,
}: {
  label: string;
  value: string | number;
  sub: string;
  icon: IconName;
  iconColor: string;
  iconBg: string;
  testid: string;
}) {
  return (
    <div
      data-testid={testid}
      style={{
        background: "var(--bg-card)",
        borderRadius: "10px",
        padding: "20px",
        border: "1px solid var(--border)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        display: "flex",
        gap: "14px",
        alignItems: "flex-start",
      }}
    >
      <div
        style={{
          width: "40px",
          height: "40px",
          borderRadius: "10px",
          background: iconBg,
          color: iconColor,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Icon name={icon} size={20} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: "28px",
            fontWeight: 700,
            lineHeight: 1.15,
            letterSpacing: "-0.01em",
            color: "var(--text-primary)",
          }}
        >
          {value}
        </div>
        <div
          style={{
            fontSize: "13px",
            color: "var(--text-primary)",
            fontWeight: 500,
            marginTop: "2px",
          }}
        >
          {label}
        </div>
        <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}>
          {sub}
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h3
      style={{
        fontSize: "13px",
        fontWeight: 600,
        color: "var(--text-secondary)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        margin: "0 0 16px",
      }}
    >
      {title}
    </h3>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [, forceUpdate] = useState(0);
  useEffect(() => i18n.onChange(() => forceUpdate((n) => n + 1)), []);

  const { data: status } = useSystemStatus();
  const isAdmin = status?.user?.role === "admin";
  const [selectedUserId, setSelectedUserId] = useState("");
  const { data: usersData } = useQuery({
    queryKey: ["users", "dashboard-filter"],
    queryFn: () => api.users.list(),
    enabled: isAdmin,
  });

  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", selectedUserId],
    queryFn: () => api.dashboard.get("30d", selectedUserId || undefined),
    // No refetchInterval: server SSE invalidates ["dashboard"] on every
    // task_state and findings_indexed event (see useNotifications).
  });

  if (isLoading || !data) {
    return (
      <div
        data-testid="dashboard-page"
        style={{ padding: "40px", color: "var(--text-secondary)" }}
      >
        {i18n.t("dashboard.loading")}
      </div>
    );
  }

  const stats = data.stats ?? {};
  const sevDist = data.severity_dist ?? {};
  const vulnerabilityTypeTop5 = data.vulnerability_type_top5 ?? [];
  const recentScans = data.recent_scans ?? [];

  const totalVulns = Object.values(sevDist as Record<string, number>).reduce(
    (s: number, v) => s + (v as number),
    0,
  );
  const sevMax = Math.max(...Object.values(sevDist as Record<string, number>), 1);

  const sevLabelKey = {
    high: "findings.sevHigh",
    medium: "findings.sevMedium",
    low: "findings.sevLow",
    info: "findings.sevInfo",
  } as const;

  return (
    <div
      data-testid="dashboard-page"
      style={{ padding: "32px 40px 48px", minHeight: "100vh", background: "var(--bg-page)" }}
    >
      <div style={{ marginBottom: "24px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px" }}>
        <div>
        <h1
          style={{
            fontSize: "24px",
            fontWeight: 700,
            margin: 0,
            letterSpacing: "-0.01em",
          }}
        >
          {i18n.t("dashboard.title")}
        </h1>
        <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: "4px 0 0" }}>
          {i18n.locale() === "zh" ? "安全审计总览与统计" : "Security audit overview"}
        </p>
        </div>
        {isAdmin && (
          <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--text-secondary)" }}>
            {i18n.t("filters.user")}
            <select data-testid="dashboard-user-filter" value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} style={{ height: "34px", border: "1px solid var(--border)", borderRadius: "6px", padding: "0 10px", background: "var(--bg-card)", color: "var(--text-primary)" }}>
              <option value="">{i18n.t("filters.allUsers")}</option>
              {(usersData?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
            </select>
          </label>
        )}
      </div>

      {/* Stat cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4,1fr)",
          gap: "16px",
          marginBottom: "20px",
        }}
      >
        <StatCard
          testid="dashboard-stat-card-scans"
          label={i18n.t("dashboard.totalScans")}
          value={stats.total_scans?.value ?? 0}
          sub={stats.total_scans?.delta ?? ""}
          icon="file-text"
          iconColor="#2563eb"
          iconBg="var(--bg-info)"
        />
        <StatCard
          testid="dashboard-stat-card-vulns"
          label={i18n.t("dashboard.vulnerabilities")}
          value={totalVulns}
          sub={`${(sevDist.high as number) ?? 0}H · ${(sevDist.medium as number) ?? 0}M · ${(sevDist.low as number) ?? 0}L · ${(sevDist.info as number) ?? 0}I`}
          icon="shield"
          iconColor="var(--brand)"
          iconBg="var(--bg-error)"
        />
        <StatCard
          testid="dashboard-stat-card-duration"
          label={i18n.t("dashboard.avgDuration")}
          value={`${stats.avg_duration_min?.value ?? 0} min`}
          sub={i18n.t("dashboard.perScan")}
          icon="clock"
          iconColor="#16a34a"
          iconBg="var(--bg-success)"
        />
        <StatCard
          testid="dashboard-stat-card-tokens"
          label={i18n.t("dashboard.tokenUsage")}
          value="—"
          sub={i18n.t("dashboard.cumulative")}
          icon="activity"
          iconColor="#7c3aed"
          iconBg="var(--bg-purple)"
        />
      </div>

      {/* Charts row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "16px",
          marginBottom: "20px",
        }}
      >
        {/* Severity Distribution */}
        <div
          data-testid="dashboard-severity-chart"
          style={{
            background: "var(--bg-card)",
            borderRadius: "10px",
            padding: "22px 24px",
            border: "1px solid var(--border)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}
        >
          <SectionHeader title={i18n.t("dashboard.severityDist")} />
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {(["high", "medium", "low", "info"] as const).map((sev) => {
              const count = (sevDist[sev] as number) ?? 0;
              const pct = sevMax > 0 ? (count / sevMax) * 100 : 0;
              const clickable = count > 0;
              return (
                <div
                  key={sev}
                  data-testid={`dashboard-severity-row-${sev}`}
                  data-severity={sev}
                  onClick={
                    clickable
                      ? () => {
                          // Scroll to Recent Scans table — currently the
                          // most useful drill-down target until we have a
                          // global findings view filtered by severity.
                          const el = document.getElementById(
                            "dashboard-recent-scans",
                          );
                          if (el) {
                            el.scrollIntoView({
                              behavior: "smooth",
                              block: "start",
                            });
                          }
                        }
                      : undefined
                  }
                  title={
                    clickable
                      ? i18n.t("dashboard.severityClickHint")
                      : undefined
                  }
                  style={{
                    display: "grid",
                    gridTemplateColumns: "56px 1fr 30px",
                    alignItems: "center",
                    gap: "12px",
                    padding: "4px 6px",
                    margin: "-4px -6px",
                    borderRadius: "6px",
                    cursor: clickable ? "pointer" : "default",
                    transition: "background 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (clickable)
                      (e.currentTarget as HTMLDivElement).style.background =
                        "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background =
                      "transparent";
                  }}
                >
                  <span
                    style={{
                      color: "var(--text-secondary)",
                      fontSize: "12px",
                      fontWeight: 500,
                      textAlign: "right",
                    }}
                  >
                    {i18n.t(sevLabelKey[sev])}
                  </span>
                  <div
                    style={{
                      height: "22px",
                      background: "var(--divider)",
                      borderRadius: "4px",
                      overflow: "hidden",
                      position: "relative",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${Math.max(pct, count > 0 ? 6 : 0)}%`,
                        background: SEV_COLORS[sev],
                        borderRadius: "4px",
                        transition: "width 0.5s cubic-bezier(0.2,0.8,0.2,1)",
                      }}
                    />
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--text-secondary)", textAlign: "right" }}>
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Vulnerability Type Top 5 */}
        <div
          data-testid="dashboard-vulnerability-type-chart"
          style={{
            background: "var(--bg-card)",
            borderRadius: "10px",
            padding: "22px 24px",
            border: "1px solid var(--border)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}
        >
          <SectionHeader title={i18n.t("dashboard.vulnerabilityTypeTop5")} />
          {vulnerabilityTypeTop5.length === 0 ? (
            <div style={{ color: "var(--text-secondary)", fontSize: "13px", padding: "8px 0" }}>
              {i18n.t("dashboard.noVulnerabilityType")}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {vulnerabilityTypeTop5.map((item: { vuln_type: string; count: number }, i: number) => {
                const maxCount = vulnerabilityTypeTop5[0]?.count ?? 1;
                const pct = (item.count / maxCount) * 100;
                const color = VULN_TYPE_BAR_COLORS[i % VULN_TYPE_BAR_COLORS.length];
                return (
                  <div
                    key={i}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(180px, 1fr) 1.3fr 30px",
                      gap: "12px",
                      alignItems: "center",
                    }}
                  >
                    <span
                      title={item.vuln_type}
                      style={{
                        fontSize: "12px",
                        color: "var(--text-primary)",
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.vuln_type}
                    </span>
                    <div
                      style={{
                        height: "14px",
                        background: "var(--divider)",
                        borderRadius: "3px",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${pct}%`,
                          background: color,
                          borderRadius: "3px",
                          transition: "width 0.5s cubic-bezier(0.2,0.8,0.2,1)",
                        }}
                      />
                    </div>
                    <span
                      style={{ fontSize: "12px", color: "var(--text-secondary)", textAlign: "right" }}
                    >
                      {item.count}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Review Progress */}
      <ReviewProgressCard reviewDist={data.review_status_dist} />

      {/* Recent Scans */}
      <div
        id="dashboard-recent-scans"
        data-testid="dashboard-recent-scans"
        style={{
          background: "var(--bg-card)",
          borderRadius: "10px",
          border: "1px solid var(--border)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "18px 24px 14px" }}>
          <SectionHeader title={i18n.t("dashboard.recentScans")} />
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ borderTop: "1px solid var(--divider)", borderBottom: "1px solid var(--divider)" }}>
              {[
                i18n.t("tasks.col.project") || "Project",
                i18n.t("tasks.col.status") || "Status",
                i18n.t("tasks.col.findings") || (i18n.locale() === "zh" ? "漏洞" : "Findings"),
                i18n.t("tasks.col.riskScore"),
                i18n.t("tasks.col.duration") || (i18n.locale() === "zh" ? "耗时" : "Duration"),
                i18n.t("tasks.col.time") || (i18n.locale() === "zh" ? "时间" : "Time"),
              ].map((h, i) => (
                <th
                  key={i}
                  style={{
                    padding: "10px 20px",
                    fontSize: "11px",
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "var(--text-secondary)",
                    textAlign: "left",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recentScans.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary)" }}>
                  {i18n.t("dashboard.noScans")}
                </td>
              </tr>
            ) : (
              recentScans.map(
                (scan: {
                  id: string;
                  project_name: string;
                  state: string;
                  severity_counts: { h: number; m: number; l: number; i: number };
                  risk_score: number | null | string;
                  duration_ms: number | null;
                  created_at: string;
                }) => {
                  const risk = parseRiskScore(scan.risk_score);
                  const sc = scan.severity_counts;
                  const hasCounts = sc.h + sc.m + sc.l + sc.i > 0;
                  return (
                    <tr
                      key={scan.id}
                      data-testid="recent-scan-row"
                      data-status={scan.state}
                      onClick={() => navigate(`/tasks/${scan.id}`)}
                      style={{
                        borderBottom: "1px solid var(--divider)",
                        cursor: "pointer",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                    >
                      <td style={{ padding: "14px 20px", fontWeight: 500 }}>{scan.project_name}</td>
                      <td style={{ padding: "14px 20px" }}>
                        <StatusPill state={scan.state} />
                      </td>
                      <td style={{ padding: "14px 20px", fontSize: "12px" }}>
                        {hasCounts ? (
                          <span style={{ display: "inline-flex", gap: "6px" }}>
                            {sc.h > 0 && <MiniSevChip count={sc.h} sev="high" />}
                            {sc.m > 0 && <MiniSevChip count={sc.m} sev="medium" />}
                            {sc.l > 0 && <MiniSevChip count={sc.l} sev="low" />}
                            {sc.i > 0 && <MiniSevChip count={sc.i} sev="info" />}
                          </span>
                        ) : (
                          <span style={{ color: "var(--text-secondary)" }}>—</span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "14px 20px",
                          fontSize: "13px",
                          fontWeight: 600,
                          color: risk != null ? riskScoreColor(risk) : "var(--text-secondary)",
                        }}
                      >
                        {risk != null ? risk.toFixed(1) : "—"}
                      </td>
                      <td style={{ padding: "14px 20px", fontSize: "12px", color: "var(--text-secondary)" }}>
                        {scan.duration_ms ? `${Math.round(scan.duration_ms / 60_000)} min` : "—"}
                      </td>
                      <td style={{ padding: "14px 20px", fontSize: "12px", color: "var(--text-secondary)" }}>
                        {formatRelativeTime(scan.created_at)}
                      </td>
                    </tr>
                  );
                },
              )
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MiniSevChip({ count, sev }: { count: number; sev: keyof typeof SEV_COLORS }) {
  const letter = sev === "high" ? "H" : sev === "medium" ? "M" : sev === "low" ? "L" : "I";
  const bgMap = {
    high: "rgba(234, 88, 12, 0.14)",
    medium: "rgba(202, 138, 4, 0.14)",
    low: "rgba(37, 99, 235, 0.14)",
    info: "rgba(156, 163, 175, 0.18)",
  } as const;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 6px",
        borderRadius: "4px",
        background: bgMap[sev],
        color: SEV_COLORS[sev],
        fontSize: "11px",
        fontWeight: 700,
        letterSpacing: "0.02em",
      }}
    >
      {count}
      {letter}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Review Progress Card                                                      */
/* -------------------------------------------------------------------------- */

const REVIEW_ITEMS = [
  { key: "pending", label: "待审核", color: "var(--review-pending)" },
  { key: "confirmed", label: "已确认", color: "var(--review-confirmed)" },
  { key: "false_positive", label: "误报", color: "var(--review-false-positive)" },
  { key: "ignored", label: "忽略", color: "var(--review-ignored)" },
] as const;

function ReviewProgressCard({
  reviewDist,
}: {
  reviewDist?: { pending: number; confirmed: number; false_positive: number; ignored: number };
}) {
  const navigate = useNavigate();
  if (!reviewDist) return null;

  const total = reviewDist.pending + reviewDist.confirmed + reviewDist.false_positive + reviewDist.ignored;
  if (total === 0) return null;

  const reviewed = reviewDist.confirmed + reviewDist.false_positive + reviewDist.ignored;
  const pct = Math.round((reviewed / total) * 100);

  return (
    <div
      data-testid="dashboard-review-progress"
      style={{
        background: "var(--bg-card)",
        borderRadius: "10px",
        padding: "16px 20px",
        border: "1px solid var(--border)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        marginBottom: "20px",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
        {i18n.t("review.dashboard.title")}
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        {REVIEW_ITEMS.map((item) => {
          const count = reviewDist[item.key];
          return (
            <div
              key={item.key}
              onClick={() => navigate(`/tasks?review_status=${item.key}`)}
              style={{
                cursor: "pointer",
                padding: "8px 12px",
                borderRadius: 6,
                textAlign: "center",
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ fontSize: 20, fontWeight: 700, color: item.color }}>{count}</div>
              <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>{item.label}</div>
            </div>
          );
        })}
      </div>
      {/* Progress bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--divider)", overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: "var(--review-confirmed)",
              borderRadius: 3,
              transition: "width 0.5s",
            }}
          />
        </div>
        <span style={{ fontSize: 11, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
          {pct}% 已审核
        </span>
      </div>
    </div>
  );
}
