import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";

const SEV_COLORS = {
  high: "var(--sev-high)",
  medium: "var(--sev-medium)",
  low: "var(--sev-low)",
  info: "var(--sev-info)",
};

const STATE_COLORS: Record<string, string> = {
  running: "var(--status-running)",
  completed: "var(--status-completed)",
  failed: "var(--status-failed)",
  cancelled: "var(--status-cancelled)",
  queued: "var(--status-queued)",
};

function StatCard({
  label,
  value,
  sub,
  iconBg,
  icon,
  testid,
}: {
  label: string;
  value: string | number;
  sub: string;
  iconBg: string;
  icon: string;
  testid: string;
}) {
  return (
    <div
      data-testid={testid}
      style={{
        background: "var(--bg-card)",
        borderRadius: "10px",
        padding: "20px 24px",
        border: "1px solid var(--border)",
        display: "flex",
        gap: "16px",
        alignItems: "flex-start",
      }}
    >
      <div
        style={{
          width: "44px",
          height: "44px",
          borderRadius: "10px",
          background: iconBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "20px",
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "4px" }}>
          {label}
        </div>
        <div style={{ fontSize: "28px", fontWeight: 800, lineHeight: 1 }}>{value}</div>
        <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}>{sub}</div>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [, forceUpdate] = useState(0);
  useEffect(() => i18n.onChange(() => forceUpdate((n) => n + 1)), []);

  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () =>
      fetch("/api/dashboard?range=30d", { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 60_000,
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
  const cweTop5 = data.cwe_top5 ?? [];
  const recentScans = data.recent_scans ?? [];

  const totalVulns = Object.values(sevDist as Record<string, number>).reduce(
    (s: number, v) => s + (v as number),
    0,
  );
  const sevMax = Math.max(...Object.values(sevDist as Record<string, number>), 1);

  return (
    <div
      data-testid="dashboard-page"
      style={{ padding: "40px", minHeight: "100vh", background: "var(--bg-page)" }}
    >
      <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 28px" }}>{i18n.t("dashboard.title")}</h1>

      {/* Stat cards */}
      <div
        style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "16px", marginBottom: "24px" }}
      >
        <StatCard
          testid="dashboard-stat-card-scans"
          label={i18n.t("dashboard.totalScans")}
          value={stats.total_scans?.value ?? 0}
          sub={`${stats.total_scans?.delta ?? ""}`}
          iconBg="var(--bg-info)"
          icon="📋"
        />
        <StatCard
          testid="dashboard-stat-card-vulns"
          label={i18n.t("dashboard.vulnerabilities")}
          value={totalVulns}
          sub={`${(sevDist.high as number) ?? 0}H · ${(sevDist.medium as number) ?? 0}M · ${(sevDist.low as number) ?? 0}L`}
          iconBg="var(--bg-error)"
          icon="🔴"
        />
        <StatCard
          testid="dashboard-stat-card-duration"
          label={i18n.t("dashboard.avgDuration")}
          value={`${stats.avg_duration_min?.value ?? 0} min`}
          sub={i18n.t("dashboard.perScan")}
          iconBg="var(--bg-success)"
          icon="⏱"
        />
        <StatCard
          testid="dashboard-stat-card-tokens"
          label={i18n.t("dashboard.tokenUsage")}
          value="—"
          sub={i18n.t("dashboard.cumulative")}
          iconBg="var(--bg-purple)"
          icon="🔮"
        />
      </div>

      {/* Charts row */}
      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "24px" }}
      >
        {/* Severity Distribution */}
        <div
          data-testid="dashboard-severity-chart"
          style={{
            background: "var(--bg-card)",
            borderRadius: "10px",
            padding: "20px 24px",
            border: "1px solid var(--border)",
          }}
        >
          <h3 style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 16px" }}>
            {i18n.t("dashboard.severityDist")}
          </h3>
          {(["high", "medium", "low", "info"] as const).map((sev) => {
            const count = (sevDist[sev] as number) ?? 0;
            const pct = sevMax > 0 ? (count / sevMax) * 100 : 0;
            return (
              <div key={sev} style={{ marginBottom: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "4px" }}>
                  <span style={{ color: SEV_COLORS[sev], fontWeight: 600, textTransform: "capitalize" }}>{sev}</span>
                  <span style={{ color: "var(--text-secondary)" }}>{count}</span>
                </div>
                <div style={{ height: "8px", background: "var(--border)", borderRadius: "4px", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: SEV_COLORS[sev], borderRadius: "4px", transition: "width 0.5s" }} />
                </div>
              </div>
            );
          })}
        </div>

        {/* CWE Top 5 */}
        <div
          data-testid="dashboard-cwe-chart"
          style={{
            background: "var(--bg-card)",
            borderRadius: "10px",
            padding: "20px 24px",
            border: "1px solid var(--border)",
          }}
        >
          <h3 style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 16px" }}>
            {i18n.t("dashboard.cweTop5")}
          </h3>
          {cweTop5.length === 0 ? (
            <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>{i18n.t("dashboard.noCwe")}</div>
          ) : (
            cweTop5.map((item: { cwe: string | null; count: number }, i: number) => {
              const maxCount = cweTop5[0]?.count ?? 1;
              const pct = (item.count / maxCount) * 100;
              return (
                <div key={i} style={{ marginBottom: "10px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "4px" }}>
                    <span style={{ fontWeight: 500 }}>{item.cwe ?? "Unknown"}</span>
                    <span style={{ color: "var(--text-secondary)" }}>{item.count}</span>
                  </div>
                  <div style={{ height: "8px", background: "var(--border)", borderRadius: "4px", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: "var(--chart-bar)", borderRadius: "4px" }} />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Recent Scans */}
      <div
        data-testid="dashboard-recent-scans"
        style={{ background: "var(--bg-card)", borderRadius: "10px", border: "1px solid var(--border)" }}
      >
        <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--divider)" }}>
          <h3 style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", margin: 0 }}>
            {i18n.t("dashboard.recentScans")}
          </h3>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <tbody>
            {recentScans.length === 0 ? (
              <tr>
                <td style={{ padding: "24px", textAlign: "center", color: "var(--text-secondary)" }}>
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
                  risk_score: number | null;
                  duration_ms: number | null;
                  created_at: string;
                }) => (
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
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-page)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                  >
                    <td style={{ padding: "12px 24px", fontWeight: 500 }}>{scan.project_name}</td>
                    <td style={{ padding: "12px 16px" }}>
                      <span
                        style={{
                          color: STATE_COLORS[scan.state] ?? "var(--status-cancelled)",
                          fontSize: "12px",
                          fontWeight: 600,
                          textTransform: "capitalize",
                        }}
                      >
                        ● {scan.state}
                      </span>
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: "12px", color: "var(--text-secondary)" }}>
                      {scan.severity_counts.h > 0 && (
                        <span style={{ color: SEV_COLORS.high, marginRight: "6px", fontWeight: 600 }}>
                          {scan.severity_counts.h}H
                        </span>
                      )}
                      {scan.severity_counts.m > 0 && (
                        <span style={{ color: SEV_COLORS.medium, marginRight: "6px", fontWeight: 600 }}>
                          {scan.severity_counts.m}M
                        </span>
                      )}
                      {scan.severity_counts.l > 0 && (
                        <span style={{ color: SEV_COLORS.low, fontWeight: 600 }}>
                          {scan.severity_counts.l}L
                        </span>
                      )}
                      {!scan.severity_counts.h && !scan.severity_counts.m && !scan.severity_counts.l && (
                        <span>—</span>
                      )}
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: "12px", color: "var(--text-secondary)" }}>
                      {scan.duration_ms ? `${Math.round(scan.duration_ms / 60_000)} min` : "—"}
                    </td>
                    <td style={{ padding: "12px 24px", fontSize: "12px", color: "var(--text-secondary)" }}>
                      {new Date(scan.created_at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                  </tr>
                ),
              )
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
