import { useEffect, useState } from "react";
import { api, type FindingMeta, type Task } from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";
import type { ChatReferenceArtifact } from "../../types.js";
import {
  DetailHeader,
  ErrorState,
  formatDuration,
  KvRow,
  LoadingState,
  NotFoundState,
  SECTION,
  severityColor,
  SMALL_BUTTON,
  StatusPill,
  TITLE,
} from "./shared.js";

export function TaskRefDetail({ artifact }: { artifact: ChatReferenceArtifact }) {
  const [data, setData] = useState<{
    task: Task;
    findings: FindingMeta[];
    allFindings: FindingMeta[] | null;
  } | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(false);
    Promise.all([
      api.tasks.get(artifact.task_id),
      api.findings.list(artifact.task_id, { limit: 5 }),
    ])
      .then(async ([taskRes, findingsRes]) => {
        const allFindings = taskRes.task.severity_counts
          ? null
          : (await api.findings.list(artifact.task_id, { limit: 1000 })).findings;
        if (mounted) {
          setData({ task: taskRes.task, findings: findingsRes.findings, allFindings });
        }
      })
      .catch(() => mounted && setError(true))
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, [artifact.task_id, nonce]);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState onRetry={() => setNonce((n) => n + 1)} />;
  if (!data) return <NotFoundState />;

  const { task, findings, allFindings } = data;
  const source = task.source_meta?.git_url || task.source_meta?.filename || task.source_type || "—";
  const counts = task.severity_counts
    ? {
        h: task.severity_counts.high,
        m: task.severity_counts.medium,
        l: task.severity_counts.low,
        i: task.severity_counts.info,
      }
    : allFindings
      ? countFindingsBySeverity(allFindings)
      : null;
  const total = counts ? Math.max(1, counts.h + counts.m + counts.l + counts.i) : 1;
  const canPause = task.state === "running";
  const canResume = task.state === "paused";

  async function control(action: "pause" | "cancel" | "restart") {
    if (action === "pause") await api.tasks.pause(task.id);
    if (action === "cancel") await api.tasks.cancel(task.id);
    if (action === "restart") await api.tasks.restart(task.id);
    setNonce((n) => n + 1);
  }

  return (
    <div data-testid="ref-detail-task" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
      <DetailHeader
        icon="tasks"
        color="var(--brand)"
        title={task.display_name || task.project_name}
        to={`/tasks/${task.id}`}
      />
      <KvRow label="Status" value={<StatusPill value={task.state} />} />
      <KvRow label="Source" value={source} mono />
      <KvRow
        label="Model"
        value={task.credential_label || task.metadata?.execution?.model || "—"}
      />
      <KvRow label="Duration" value={formatDuration(task.duration_ms)} />
      <section style={SECTION}>
        <div style={TITLE}>{i18n.t("chat.ref.task.severity")}</div>
        {counts ? (
          <>
            <div
              style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", gap: 2 }}
            >
              {[
                ["h", counts.h, "var(--sev-high)"],
                ["m", counts.m, "var(--sev-medium)"],
                ["l", counts.l, "var(--sev-low)"],
                ["i", counts.i, "var(--sev-info)"],
              ].map(([key, count, color]) => (
                <div
                  key={key}
                  style={{
                    flex: Number(count) / total,
                    minWidth: Number(count) ? 6 : 0,
                    background: String(color),
                    borderRadius: 4,
                  }}
                />
              ))}
            </div>
            <div
              style={{
                display: "flex",
                gap: 14,
                marginTop: 8,
                fontSize: 11,
                color: "var(--text-secondary)",
              }}
            >
              <span>H:{counts.h}</span>
              <span>M:{counts.m}</span>
              <span>L:{counts.l}</span>
              <span>I:{counts.i}</span>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: "var(--text-secondary)", padding: "8px 0" }}>
            Unavailable
          </div>
        )}
      </section>
      <section style={SECTION}>
        <div style={TITLE}>{i18n.t("chat.ref.task.topFindings")}</div>
        {findings.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-secondary)", padding: "12px 0" }}>
            {i18n.t("chat.ref.task.noFindings")}
          </div>
        ) : (
          findings.map((f) => (
            <div
              key={f.finding_key}
              style={{ padding: "6px 0", display: "flex", gap: 8, alignItems: "baseline" }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: severityColor(f.severity),
                  flexShrink: 0,
                }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
                  {f.vuln_type || f.finding_key}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: "monospace",
                    color: "var(--text-secondary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {f.primary_file || "—"}
                  {f.primary_line ? `:${f.primary_line}` : ""}
                </div>
              </div>
            </div>
          ))
        )}
      </section>
      {canPause || canResume ? (
        <section style={{ padding: "14px 18px", display: "flex", gap: 8 }}>
          {canPause ? (
            <button
              data-testid="ref-task-pause"
              type="button"
              style={SMALL_BUTTON}
              onClick={() => void control("pause")}
            >
              Pause
            </button>
          ) : null}
          <button
            data-testid="ref-task-cancel"
            type="button"
            style={SMALL_BUTTON}
            onClick={() => void control("cancel")}
          >
            Cancel
          </button>
          {canResume ? (
            <button
              data-testid="ref-task-restart"
              type="button"
              style={{ ...SMALL_BUTTON, background: "var(--brand)", color: "#fff", border: "none" }}
              onClick={() => void control("restart")}
            >
              Restart
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function countFindingsBySeverity(findings: FindingMeta[]) {
  const counts = { h: 0, m: 0, l: 0, i: 0 };
  for (const finding of findings) {
    const severity = finding.severity.toLowerCase();
    if (severity.includes("high") || severity.includes("critical")) counts.h += 1;
    else if (severity.includes("medium")) counts.m += 1;
    else if (severity.includes("low")) counts.l += 1;
    else counts.i += 1;
  }
  return counts;
}
