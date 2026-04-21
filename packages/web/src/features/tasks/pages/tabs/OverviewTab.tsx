import { useState, useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Task } from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "var(--bg-card)",
        borderRadius: "10px",
        padding: "20px 24px",
        border: "1px solid var(--border)",
      }}
    >
      <h3 style={{ fontSize: "13px", fontWeight: 600, margin: "0 0 16px", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--divider)", fontSize: "13px" }}>
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span style={{ fontWeight: 500, color: "var(--text-primary)" }}>{value ?? "—"}</span>
    </div>
  );
}

const SEV_COLORS: Record<string, string> = {
  high: "var(--sev-high)", medium: "var(--sev-medium)", low: "var(--sev-low)", info: "var(--sev-info)",
};

export function OverviewTab() {
  const { task } = useOutletContext<{ task: Task }>();
  const [, forceUpdate] = useState(0);
  useEffect(() => i18n.onChange(() => forceUpdate((n) => n + 1)), []);

  const { data: findingsData } = useQuery({
    queryKey: ["findings", task.id],
    queryFn: () => api.findings.list(task.id),
    enabled: task.state === "completed",
    refetchInterval: (query) => {
      // Refetch until findings arrive (race with indexer)
      return query.state.data?.findings?.length ? false : 3000;
    },
  });

  const findings = findingsData?.findings ?? [];
  const highCount = findings.filter((f) => f.severity === "high").length;
  const medCount = findings.filter((f) => f.severity === "medium").length;

  return (
    <div data-testid="task-detail-panel-overview" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
      {/* Project Profile */}
      <Card title={i18n.t("overview.projectProfile")}>
        <KV label="Project" value={task.project_name} />
        <KV label="Source" value={task.source_type === "git" ? "Git Repository" : "Uploaded Archive"} />
        <KV label="Status" value={task.state} />
        <KV label="Created" value={task.created_at ? new Date(task.created_at).toLocaleDateString() : null} />
      </Card>

      {/* Risk Assessment */}
      <Card title={i18n.t("overview.riskAssessment")}>
        {task.risk_score != null ? (() => {
          const rs = parseFloat(String(task.risk_score));
          return (
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <div
              style={{
                fontSize: "48px",
                fontWeight: 800,
                color: rs >= 7 ? "var(--sev-high)" : rs >= 4 ? "var(--sev-medium)" : "var(--status-completed)",
                lineHeight: 1,
              }}
            >
              {rs.toFixed(1)}
            </div>
            <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px" }}>/ 10</div>
          </div>
          );
        })() : (
          <div style={{ color: "var(--text-secondary)", fontSize: "13px", padding: "16px 0" }}>
            {task.state === "completed" ? "Score not available" : "Analysis in progress…"}
          </div>
        )}

        {/* Severity mini bar */}
        {findings.length > 0 && (
          <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
            {(["high", "medium", "low", "info"] as const).map((s) => {
              const count = findings.filter((f) => f.severity === s).length;
              return count > 0 ? (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px" }}>
                  <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: SEV_COLORS[s], display: "inline-block" }} />
                  {count} {s}
                </div>
              ) : null;
            })}
          </div>
        )}
      </Card>

      {/* Key Findings */}
      <Card title={`Key Findings (${findings.length} total)`}>
        {findings.length === 0 ? (
          <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
            {task.state === "completed" ? "No findings" : "Scan in progress…"}
          </div>
        ) : (
          findings.slice(0, 5).map((f) => (
            <div
              key={f.id}
              style={{
                padding: "8px 0",
                borderBottom: "1px solid var(--divider)",
                display: "flex",
                gap: "8px",
                alignItems: "flex-start",
                fontSize: "12px",
              }}
            >
              <span
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: SEV_COLORS[f.severity],
                  flexShrink: 0,
                  marginTop: "3px",
                }}
              />
              <div>
                <div style={{ fontWeight: 500 }}>{f.finding_key}</div>
                {f.primary_file && (
                  <div style={{ color: "var(--text-secondary)", fontFamily: "monospace" }}>
                    {f.primary_file}{f.primary_line ? `:${f.primary_line}` : ""}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </Card>

      {/* Execution Summary */}
      <Card title={i18n.t("overview.executionSummary")}>
        <KV label="Duration" value={task.duration_ms ? `${Math.round(task.duration_ms / 60_000)} min` : null} />
        <KV label="Findings" value={findings.length > 0 ? findings.length : null} />
        <KV label="High" value={highCount > 0 ? highCount : null} />
        <KV label="Medium" value={medCount > 0 ? medCount : null} />
      </Card>
    </div>
  );
}
