import { useState, useEffect, useRef } from "react";
import { useOutletContext, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Task, type FindingMeta, type ProfilerData } from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";
import { Icon, type IconName } from "../../../../shared/components/Icon.js";
import { formatDateTime } from "../../../../shared/utils/format.js";

/**
 * Normalize `task.source_meta` — backend postgres returns it as a JSON
 * string for this column, not a parsed object. Callers expect an object.
 * Gracefully handles: already-parsed object, string, null, malformed JSON.
 */
function parseSourceMeta(
  raw: Task["source_meta"] | string | null | undefined,
): {
  filename?: string;
  minio_key?: string;
  size_bytes?: number;
  git_url?: string;
  git_branch?: string;
  [key: string]: unknown;
} | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Human-readable bytes (1.2 MB / 456 KB / 789 B). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

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
  const navigate = useNavigate();
  const [, forceUpdate] = useState(0);
  useEffect(() => i18n.onChange(() => forceUpdate((n) => n + 1)), []);

  const { data: findingsData } = useQuery({
    queryKey: ["findings", task.id],
    queryFn: () => api.findings.list(task.id),
    // Server SSE (`findings_indexed`) invalidates this key when the scan
    // finishes, so no refetchInterval is needed.
  });

  const { data: pocSummaryData } = useQuery({
    queryKey: ["poc-summary", task.id],
    queryFn: () => api.tasks.pocSummary(task.id),
    retry: false,
  });

  const { data: profilerData } = useQuery({
    queryKey: ["task-profiler", task.id],
    queryFn: () => api.tasks.profiler(task.id),
    retry: false,
  });
  const profiler = profilerData?.profiler ?? null;

  const findings = (findingsData?.findings ?? []) as FindingMeta[];
  const counts = {
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    info: findings.filter((f) => f.severity === "info").length,
  };
  const confirmedCount = findings.filter((f) => f.review_status === "confirmed").length;
  const falsePositiveCount = findings.filter((f) => f.review_status === "false_positive").length;
  const reproducedCount = pocSummaryData?.summary?.reproduced ?? 0;
  const profile = task.metadata?.profile ?? {};
  const exec = task.metadata?.execution ?? {};

  const tokenUsage = getTokenUsage(task);
  const toolCalls = Number(exec.tool_call_count ?? task.tool_call_count ?? 0);

  // All findings sorted by severity weight desc
  const sevWeight: Record<string, number> = { high: 4, medium: 3, low: 2, info: 1 };
  const sortedFindings = [...findings]
    .sort((a, b) => (sevWeight[b.severity] ?? 0) - (sevWeight[a.severity] ?? 0));

  return (
    <div
      data-testid="task-detail-panel-overview"
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "20px",
      }}
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
        {/* U8: surface source_meta so users can see exactly what was scanned.
            Backend returns this as a JSON string, so we parse defensively. */}
        {(() => {
          const sm = parseSourceMeta(task.source_meta as unknown as string);
          if (!sm) return null;
          return (
            <>
              {sm.git_url && (
                <KV
                  label={i18n.t("overview.gitUrl")}
                  value={
                    <a
                      href={sm.git_url}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        color: "var(--text-primary)",
                        wordBreak: "break-all",
                      }}
                    >
                      {sm.git_url}
                    </a>
                  }
                />
              )}
              {sm.git_branch && (
                <KV
                  label={i18n.t("overview.gitBranch")}
                  value={sm.git_branch}
                />
              )}
              {sm.filename && (
                <KV
                  label={i18n.t("overview.filename")}
                  value={
                    <span style={{ wordBreak: "break-all" }}>
                      {sm.filename}
                    </span>
                  }
                />
              )}
              {typeof sm.size_bytes === "number" && (
                <KV
                  label={i18n.t("overview.size")}
                  value={formatBytes(sm.size_bytes)}
                />
              )}
            </>
          );
        })()}
        <CredentialField task={task} />
        <ScanBudgetField task={task} />
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

      {/* Vulnerability Overview — factual counts, no risk score */}
      <Card title={i18n.t("overview.vulnerabilityOverview")}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "150px 1fr",
            gap: "20px",
            alignItems: "stretch",
            marginBottom: "18px",
          }}
        >
          <div
            style={{
              background: "var(--bg-page)",
              border: "1px solid var(--divider)",
              borderRadius: "12px",
              padding: "18px 16px",
              minHeight: "128px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
            }}
          >
            <div
              data-testid="overview-total-findings"
              style={{
                fontSize: "46px",
                fontWeight: 800,
                letterSpacing: "-0.04em",
                lineHeight: 0.95,
                color: "var(--text-primary)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {findings.length}
            </div>
            <div
              style={{
                fontSize: "13px",
                fontWeight: 700,
                color: "var(--text-primary)",
                marginTop: "10px",
              }}
            >
              {i18n.t("overview.totalFindings")}
            </div>
            <div style={{ fontSize: "12px", color: "var(--text-muted, var(--text-secondary))", marginTop: "4px" }}>
              {i18n.t("overview.indexedFindings")}
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: "10px",
              alignSelf: "start",
            }}
          >
            {(["high", "medium", "low", "info"] as const).map((s) => (
              <SeverityStat key={s} severity={s} count={counts[s]} />
            ))}
          </div>
        </div>

        <SevBar counts={counts} />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "10px",
          }}
        >
          <FactStat label={i18n.t("overview.confirmedFindings")} value={confirmedCount} tone="confirmed" />
          <FactStat label={i18n.t("overview.falsePositiveFindings")} value={falsePositiveCount} tone="neutral" />
          <FactStat label={i18n.t("overview.pocReproduced")} value={reproducedCount} tone="poc" />
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
            {sortedFindings.map((f) => (
              <div
                key={f.id}
                data-testid="overview-key-finding"
                data-finding-key={f.finding_key}
                onClick={() =>
                  navigate(
                    `/tasks/${task.id}/findings?bug=${encodeURIComponent(
                      f.finding_key,
                    )}`,
                  )
                }
                title={i18n.t("overview.keyFindingClickHint")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  padding: "10px 14px",
                  background: "var(--bg-page)",
                  borderRadius: "6px",
                  border: "1px solid var(--border)",
                  fontSize: "13px",
                  cursor: "pointer",
                  transition: "background 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background =
                    "var(--bg-hover)";
                  (e.currentTarget as HTMLDivElement).style.borderColor =
                    "var(--brand)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background =
                    "var(--bg-page)";
                  (e.currentTarget as HTMLDivElement).style.borderColor =
                    "var(--border)";
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
      {profiler && <ProfilerCard profiler={profiler} />}

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
        <TokenUsageBlock usage={tokenUsage} />
        <KV
          label={i18n.t("overview.toolCalls")}
          value={toolCalls > 0 ? toolCalls.toLocaleString() : null}
        />
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Phase 4: Profiler card + Coverage card                                   */
/* -------------------------------------------------------------------------- */

const LANG_BAR_COLORS = [
  "var(--brand)",
  "var(--sev-medium)",
  "var(--sev-low)",
  "var(--sev-info)",
  "var(--text-secondary)",
];

function ProfilerCard({ profiler }: { profiler: ProfilerData }) {
  const name = profiler.basic_info?.project_name;
  const fileCount = profiler.code_stats?.file_count;
  const loc = profiler.code_stats?.loc;
  const buildSystem = profiler.tech_stack?.build_system;
  const deps = profiler.tech_stack?.main_dependencies ?? [];
  const languages = (profiler.code_stats?.languages ?? []).slice(0, 6);

  return (
    <Card title={i18n.t("overview.profilerCard")} icon="cpu">
      {name && <KV label={i18n.t("overview.profilerName")} value={name} />}
      {fileCount != null && (
        <KV label={i18n.t("overview.profilerFiles")} value={fileCount.toLocaleString()} />
      )}
      {loc != null && (
        <KV label={i18n.t("overview.profilerLoc")} value={loc.toLocaleString()} />
      )}
      {buildSystem && <KV label={i18n.t("overview.profilerBuild")} value={buildSystem} />}

      {languages.length > 0 && (
        <div style={{ marginTop: "14px" }}>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "8px" }}>
            {i18n.t("overview.profilerLanguages")}
          </div>
          {/* Stacked horizontal bar */}
          <div style={{ display: "flex", height: "10px", borderRadius: "5px", overflow: "hidden", marginBottom: "10px" }}>
            {languages.map((l, i) => (
              <div
                key={l.name}
                title={`${l.name} ${l.percentage}%`}
                style={{ width: `${l.percentage}%`, background: LANG_BAR_COLORS[i % LANG_BAR_COLORS.length] }}
              />
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
            {languages.map((l, i) => (
              <div key={l.name} style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "var(--text-secondary)" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: LANG_BAR_COLORS[i % LANG_BAR_COLORS.length], flexShrink: 0 }} />
                <span>{l.name}</span>
                <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-primary)" }}>{l.percentage}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {deps.length > 0 && (
        <div style={{ marginTop: "14px" }}>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "6px" }}>
            {i18n.t("overview.profilerDeps")}
          </div>
          <div style={{ fontSize: "12.5px", color: "var(--text-primary)", lineHeight: 1.6 }}>
            {deps.join(" · ")}
          </div>
        </div>
      )}
    </Card>
  );
}

function getTokenUsage(task: Task) {
  const exec = task.metadata?.execution ?? {};
  const input = Number(exec.input_tokens ?? task.input_tokens ?? exec.total_tokens_in ?? task.total_tokens_in ?? 0) || 0;
  const output = Number(exec.output_tokens ?? task.output_tokens ?? exec.total_tokens_out ?? task.total_tokens_out ?? 0) || 0;
  const cacheRead = Number(exec.cache_read_tokens ?? task.cache_read_tokens ?? 0) || 0;
  const cacheWrite = Number(exec.cache_write_tokens ?? task.cache_write_tokens ?? 0) || 0;
  const computed = input + output + cacheRead + cacheWrite;
  const total = Number(exec.total_tokens ?? task.total_tokens ?? 0) || computed;
  return { input, output, cacheRead, cacheWrite, total: Math.max(total, computed) };
}

function TokenUsageBlock({ usage }: { usage: ReturnType<typeof getTokenUsage> }) {
  if (usage.total <= 0) {
    return <KV label={i18n.t("overview.aiUsage")} value={null} />;
  }
  return (
    <div
      title={i18n.t("overview.tokenUsageTooltip")}
      style={{ padding: "10px 0", borderBottom: "1px solid var(--divider)" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "12px" }}>
        <span style={{ color: "var(--text-secondary)", fontSize: "13px" }}>{i18n.t("overview.aiUsage")}</span>
        <span style={{ fontSize: "22px", fontWeight: 800, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
          {formatTokens(usage.total)}
        </span>
      </div>
      <div style={{ textAlign: "right", fontSize: "12px", color: "var(--text-secondary)", fontWeight: 600, marginTop: "2px" }}>
        {i18n.t("overview.totalTokens")}
      </div>
      <div style={{ textAlign: "right", fontSize: "11px", color: "var(--text-muted, var(--text-secondary))", marginTop: "6px" }}>
        {i18n.t("overview.inputTokensShort")} {formatTokens(usage.input)} · {i18n.t("overview.outputTokensShort")} {formatTokens(usage.output)} · {i18n.t("overview.cacheReadTokensShort")} {formatTokens(usage.cacheRead)} · {i18n.t("overview.cacheWriteTokensShort")} {formatTokens(usage.cacheWrite)}
      </div>
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

function SeverityStat({ severity, count }: { severity: "high" | "medium" | "low" | "info"; count: number }) {
  const labelKey = `findings.sev${severity.charAt(0).toUpperCase() + severity.slice(1)}`;
  return (
    <div
      data-testid={`overview-severity-${severity}`}
      style={{
        padding: "13px 12px",
        border: "1px solid var(--divider)",
        borderRadius: "10px",
        background: "var(--bg-card)",
      }}
    >
      <div style={{ fontSize: "26px", fontWeight: 800, color: count === 0 ? "var(--text-muted, var(--text-secondary))" : SEV_COLORS[severity], lineHeight: 1 }}>
        {count}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          fontSize: "12px",
          color: "var(--text-secondary)",
          marginTop: "6px",
          fontWeight: 600,
        }}
      >
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: SEV_COLORS[severity],
            flexShrink: 0,
          }}
        />
        {i18n.t(labelKey)}
      </div>
    </div>
  );
}

function FactStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: "confirmed" | "neutral" | "poc";
}) {
  const toneColor = tone === "confirmed" ? "#16a34a" : tone === "poc" ? "#7c3aed" : "var(--text-secondary)";
  return (
    <div
      style={{
        background: "var(--bg-page)",
        border: "1px solid var(--divider)",
        borderRadius: "10px",
        padding: "12px 13px",
      }}
    >
      <div style={{ fontSize: "24px", fontWeight: 800, color: toneColor, lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "6px", fontWeight: 600 }}>
        {label}
      </div>
    </div>
  );
}

function SevBar({ counts }: { counts: { high: number; medium: number; low: number; info: number } }) {
  const total = counts.high + counts.medium + counts.low + counts.info;
  if (total === 0) {
    return (
      <div
        style={{
          height: "8px",
          background: "var(--divider)",
          borderRadius: "999px",
          margin: "2px 0 18px",
        }}
      />
    );
  }
  return (
    <div
      style={{
        display: "flex",
        height: "8px",
        borderRadius: "999px",
        overflow: "hidden",
        margin: "2px 0 18px",
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

/* ── Credential selector (editable for paused/cancelled/failed tasks) ── */
const EDITABLE_STATES = new Set(["paused", "cancelled", "failed"]);

function formatMinutes(totalMin: number): string {
  if (totalMin < 60) return i18n.t("overview.fmtMin").replace("{m}", String(totalMin));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0
    ? i18n.t("overview.fmtHourMin").replace("{h}", String(h)).replace("{m}", String(m))
    : i18n.t("overview.fmtHour").replace("{h}", String(h));
}

/**
 * Scan time-budget display. `scan_timeout` (source_meta, seconds) is the
 * engine's soft upper bound — not a precise countdown (a task may converge and
 * finish earlier, or be stopped at the budget). Running tasks show a live
 * elapsed + remaining-budget; finished tasks show actual run time.
 */
function ScanBudgetField({ task }: { task: Task }) {
  const sm = parseSourceMeta(task.source_meta as unknown as string);
  const timeoutSec = typeof sm?.scan_timeout === "number" ? sm.scan_timeout : null;
  const isRunning = task.state === "running";

  // Live-updating clock for the running case.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [isRunning]);

  if (timeoutSec == null && task.duration_ms == null) return null;
  const budgetMin = timeoutSec != null ? Math.round(timeoutSec / 60) : null;

  let value: string;
  if (isRunning && task.started_at) {
    const elapsedMin = Math.max(0, Math.floor((now - new Date(task.started_at).getTime()) / 60_000));
    const parts = [
      budgetMin != null ? i18n.t("overview.scanBudgetValue").replace("{budget}", formatMinutes(budgetMin)) : null,
      i18n.t("overview.scanElapsed").replace("{elapsed}", formatMinutes(elapsedMin)),
    ];
    if (budgetMin != null) {
      const remaining = Math.max(0, budgetMin - elapsedMin);
      parts.push(i18n.t("overview.scanRemaining").replace("{remaining}", formatMinutes(remaining)));
    }
    value = parts.filter(Boolean).join(" · ");
  } else if (task.duration_ms != null) {
    const actualMin = Math.max(0, Math.round(task.duration_ms / 60_000));
    value = [
      budgetMin != null ? i18n.t("overview.scanBudgetValue").replace("{budget}", formatMinutes(budgetMin)) : null,
      i18n.t("overview.scanActual").replace("{actual}", formatMinutes(actualMin)),
    ].filter(Boolean).join(" · ");
  } else if (budgetMin != null) {
    value = i18n.t("overview.scanBudgetValue").replace("{budget}", formatMinutes(budgetMin));
  } else {
    return null;
  }

  return <KV label={i18n.t("overview.scanBudget")} value={`⏱ ${value}`} />;
}

function CredentialField({ task }: { task: Task }) {
  const qc = useQueryClient();
  const canEdit = EDITABLE_STATES.has(task.state);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { data: credData } = useQuery({
    queryKey: ["credentials"],
    queryFn: () => api.settings.listCredentials(),
    enabled: canEdit,
  });

  const mut = useMutation({
    mutationFn: (credId: string | null) => api.tasks.update(task.id, { credential_id: credId || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["task", task.id] });
      setOpen(false);
    },
  });

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (!canEdit) {
    if (!task.credential_label) return null;
    return <KV label={i18n.t("overview.credential")} value={task.credential_label} />;
  }

  const credentials = credData?.credentials ?? [];
  const currentLabel = task.credential_label ?? i18n.t("overview.noCredential");

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
        position: "relative",
      }}
    >
      <span style={{ color: "var(--text-secondary)" }}>
        {i18n.t("overview.credential")}
      </span>

      {/* Right side: clickable chip */}
      <div ref={dropdownRef} style={{ position: "relative" }}>
        <button
          onClick={() => setOpen(!open)}
          disabled={mut.isPending}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "3px 10px 3px 10px",
            border: "1px solid var(--divider)",
            borderRadius: "6px",
            background: open ? "var(--bg-hover)" : "transparent",
            color: "var(--text-primary)",
            fontWeight: 600,
            fontSize: "13px",
            cursor: mut.isPending ? "wait" : "pointer",
            fontFamily: "inherit",
            transition: "background 0.12s, border-color 0.12s",
            lineHeight: 1.5,
          }}
          onMouseEnter={(e) => {
            if (!open) e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            if (!open) e.currentTarget.style.background = "transparent";
          }}
        >
          {mut.isPending ? (
            <Icon name="loader" size={12} style={{ animation: "spin 1s linear infinite" }} />
          ) : null}
          <span style={{ maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {currentLabel}
          </span>
          <Icon
            name="chevron-down"
            size={12}
            style={{
              opacity: 0.5,
              transition: "transform 0.15s",
              transform: open ? "rotate(180deg)" : "rotate(0deg)",
            }}
          />
        </button>

        {/* Dropdown menu */}
        {open && (
          <div
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 4px)",
              minWidth: "220px",
              maxWidth: "320px",
              background: "var(--bg-card)",
              border: "1px solid var(--divider)",
              borderRadius: "8px",
              boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
              zIndex: 100,
              padding: "4px 0",
              maxHeight: "240px",
              overflowY: "auto",
            }}
          >
            {credentials.length === 0 ? (
              <div style={{ padding: "12px 14px", color: "var(--text-secondary)", fontSize: "12px" }}>
                {i18n.t("overview.noCredential")}
              </div>
            ) : (
              credentials.map((c) => {
                const isActive = c.id === task.credential_id;
                const label = `${c.label || c.provider} — ${c.model_id}`;
                return (
                  <button
                    key={c.id}
                    onClick={() => {
                      if (!isActive) mut.mutate(c.id);
                      else setOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      width: "100%",
                      padding: "8px 14px",
                      border: "none",
                      background: isActive ? "var(--bg-hover)" : "transparent",
                      color: "var(--text-primary)",
                      fontSize: "13px",
                      fontWeight: isActive ? 600 : 400,
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: "inherit",
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) e.currentTarget.style.background = isActive ? "var(--bg-hover)" : "transparent";
                    }}
                  >
                    <Icon
                      name="check"
                      size={14}
                      style={{
                        opacity: isActive ? 1 : 0,
                        color: "var(--brand)",
                        flexShrink: 0,
                      }}
                    />
                    <span style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {label}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
