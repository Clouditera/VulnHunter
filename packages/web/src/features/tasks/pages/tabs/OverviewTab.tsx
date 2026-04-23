import { useState, useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Task, type FindingMeta } from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";
import { Icon, type IconName } from "../../../../shared/components/Icon.js";
import {
  formatDateTime,
  parseRiskScore,
  riskScoreColor,
} from "../../../../shared/utils/format.js";

const SEV_COLORS: Record<string, string> = {
  high: "var(--sev-high)",
  medium: "var(--sev-medium)",
  low: "var(--sev-low)",
  info: "var(--sev-info)",
};

/** Overview card matching prototype `.ov-card`. Accepts an optional icon
 *  rendered inline with the title (used e.g. for the risk assessment card). */
function Card({
  title,
  icon,
  children,
  align,
}: {
  title: string;
  icon?: IconName;
  children: React.ReactNode;
  align?: "center";
}) {
  return (
    <div
      style={{
        background: "var(--bg-card)",
        borderRadius: "10px",
        padding: "22px 24px",
        border: "1px solid var(--border)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        textAlign: align,
      }}
    >
      <h4
        style={{
          fontSize: "12px",
          fontWeight: 600,
          textTransform: "uppercase",
          color: "var(--text-secondary)",
          letterSpacing: "0.06em",
          margin: "0 0 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: align === "center" ? "center" : "flex-start",
          gap: "6px",
        }}
      >
        {icon && <Icon name={icon} size={14} style={{ opacity: 0.8 }} />}
        <span>{title}</span>
      </h4>
      {children}
    </div>
  );
}

/** Key-value row: label left, value right, divider between. */
function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: "12px",
        padding: "9px 0",
        borderBottom: "1px solid var(--divider)",
        fontSize: "13px",
      }}
    >
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span style={{ fontWeight: 600, color: "var(--text-primary)", textAlign: "right" }}>
        {value ?? <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>—</span>}
      </span>
    </div>
  );
}

export function OverviewTab() {
  const { task } = useOutletContext<{ task: Task }>();
  const [, forceUpdate] = useState(0);
  useEffect(() => i18n.onChange(() => forceUpdate((n) => n + 1)), []);

  const { data: findingsData } = useQuery({
    queryKey: ["findings", task.id],
    queryFn: () => api.findings.list(task.id),
    refetchInterval: (query) => {
      // Refetch while findings might still be indexing
      if (task.state === "running") return 5000;
      return query.state.data?.findings?.length ? false : 3000;
    },
  });

  const findings = (findingsData?.findings ?? []) as FindingMeta[];
  const counts = {
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    info: findings.filter((f) => f.severity === "info").length,
  };
  const risk = parseRiskScore(task.risk_score);
  const profile = task.metadata?.profile ?? {};
  const exec = task.metadata?.execution ?? {};

  const totalTokens =
    (Number(exec.total_tokens_in ?? task.total_tokens_in ?? 0) || 0) +
    (Number(exec.total_tokens_out ?? task.total_tokens_out ?? 0) || 0);
  const toolCalls = Number(exec.tool_call_count ?? task.tool_call_count ?? 0);

  // Top 3 findings sorted by severity weight desc
  const sevWeight: Record<string, number> = { high: 4, medium: 3, low: 2, info: 1 };
  const topFindings = [...findings]
    .sort((a, b) => (sevWeight[b.severity] ?? 0) - (sevWeight[a.severity] ?? 0))
    .slice(0, 3);

  return (
    <div
      data-testid="task-detail-panel-overview"
      style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}
    >
      {/* Project Profile */}
      <Card title={i18n.t("overview.projectProfile")}>
        <KV label={i18n.t("overview.project")} value={task.project_name} />
        <KV
          label={i18n.t("overview.source")}
          value={
            task.source_type === "git"
              ? i18n.t("overview.sourceGit")
              : i18n.t("overview.sourceUpload")
          }
        />
        <KV label={i18n.t("overview.language")} value={profile.language ?? null} />
        <KV
          label={i18n.t("overview.buildSystem")}
          value={profile.build_system ?? null}
        />
        <KV
          label={i18n.t("overview.files")}
          value={profile.total_files != null ? profile.total_files.toLocaleString() : null}
        />
        <KV
          label={i18n.t("overview.loc")}
          value={profile.total_loc != null ? profile.total_loc.toLocaleString() : null}
        />
      </Card>

      {/* Risk Assessment — large number + segmented severity bar + legend */}
      <Card title={i18n.t("overview.riskAssessment")} icon="shield" align="center">
        {risk != null ? (
          <>
            <div
              style={{
                fontSize: "48px",
                fontWeight: 800,
                color: riskScoreColor(risk),
                lineHeight: 1,
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "-0.02em",
              }}
            >
              {risk.toFixed(1)}
              <span
                style={{
                  fontSize: "20px",
                  color: "var(--text-secondary)",
                  fontWeight: 500,
                  marginLeft: "4px",
                }}
              >
                / 10
              </span>
            </div>
            <div
              style={{
                fontSize: "14px",
                color: "var(--text-secondary)",
                marginTop: "6px",
              }}
            >
              {i18n.t("overview.overallRiskScore")}
            </div>
          </>
        ) : (
          <div
            style={{
              color: "var(--text-secondary)",
              fontSize: "13px",
              padding: "28px 0 6px",
            }}
          >
            {task.state === "completed" || task.state === "failed"
              ? i18n.t("overview.riskNotAvailable")
              : i18n.t("overview.analyzing")}
          </div>
        )}

        {/* Segmented severity bar — flex weights reflect counts (min 1 to stay visible) */}
        <SevBar counts={counts} />

        {/* Dot legend */}
        <div
          style={{
            display: "flex",
            gap: "16px",
            fontSize: "12px",
            color: "var(--text-secondary)",
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          {(["high", "medium", "low", "info"] as const).map((s) => (
            <span
              key={s}
              style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}
            >
              <i
                style={{
                  display: "inline-block",
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: SEV_COLORS[s],
                }}
              />
              {counts[s]} {i18n.t(`findings.sev${s.charAt(0).toUpperCase() + s.slice(1)}`)}
            </span>
          ))}
        </div>
      </Card>

      {/* Key Findings — vuln_type title + BUG-ID chip */}
      <Card
        title={`${i18n.t("overview.keyFindings")}${
          findings.length > 0
            ? ` (${i18n.t("overview.keyFindingsCount").replace("{n}", String(findings.length))})`
            : ""
        }`}
      >
        {findings.length === 0 ? (
          <div
            style={{
              color: "var(--text-secondary)",
              fontSize: "13px",
              padding: "8px 0",
            }}
          >
            {task.state === "completed"
              ? i18n.t("overview.noFindings")
              : i18n.t("overview.scanInProgress")}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {topFindings.map((f) => (
              <div
                key={f.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  padding: "10px 14px",
                  background: "var(--bg-page)",
                  borderRadius: "6px",
                  border: "1px solid var(--border)",
                  fontSize: "13px",
                }}
              >
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: SEV_COLORS[f.severity] ?? SEV_COLORS.info,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontFamily: "SF Mono, JetBrains Mono, monospace",
                    fontSize: "11px",
                    color: "var(--text-secondary)",
                    minWidth: "100px",
                    flexShrink: 0,
                  }}
                >
                  {f.finding_key}
                </span>
                <span
                  style={{
                    flex: 1,
                    fontWeight: 500,
                    color: "var(--text-primary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {f.vuln_type_full || f.vuln_type || f.finding_key}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Execution Summary */}
      <Card title={i18n.t("overview.executionSummary")}>
        <KV
          label={i18n.t("overview.duration")}
          value={task.duration_ms ? `${Math.round(task.duration_ms / 60_000)} min` : null}
        />
        <KV
          label={i18n.t("overview.created")}
          value={task.created_at ? formatDateTime(task.created_at) : null}
        />
        <KV
          label={i18n.t("overview.model")}
          value={exec.model ? shortenModel(exec.model) : null}
        />
        {/* Concurrency is a per-scan system setting (not per-task); leave "—"
            until the backend starts writing scheduler.max_parallel into
            tasks.metadata.execution. */}
        <KV label={i18n.t("overview.concurrency")} value={null} />
        <KV
          label={i18n.t("overview.tokenUsage")}
          value={totalTokens > 0 ? formatTokens(totalTokens) : null}
        />
        <KV
          label={i18n.t("overview.toolCalls")}
          value={toolCalls > 0 ? toolCalls.toLocaleString() : null}
        />
      </Card>
    </div>
  );
}

/**
 * Turn a fully-qualified model id like "openai/MiniMax-M2.5" into a compact
 * display form "MiniMax-M2.5 (openai)". Unqualified ids pass through.
 */
function shortenModel(raw: string): string {
  if (!raw.includes("/")) return raw;
  const [provider, ...rest] = raw.split("/");
  return `${rest.join("/")}  ·  ${provider}`;
}

/** 1,234,567 → "1.23M"; 1234 → "1.2K"; <1000 → "734". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function SevBar({ counts }: { counts: { high: number; medium: number; low: number; info: number } }) {
  const total = counts.high + counts.medium + counts.low + counts.info;
  if (total === 0) {
    return (
      <div
        style={{
          height: "10px",
          background: "var(--divider)",
          borderRadius: "5px",
          margin: "20px 0 14px",
        }}
      />
    );
  }
  return (
    <div
      style={{
        display: "flex",
        height: "10px",
        borderRadius: "5px",
        overflow: "hidden",
        margin: "20px 0 14px",
        background: "var(--divider)",
      }}
    >
      {(["high", "medium", "low", "info"] as const).map((s) =>
        counts[s] > 0 ? (
          <span key={s} style={{ flex: counts[s], background: SEV_COLORS[s] }} />
        ) : null,
      )}
    </div>
  );
}
