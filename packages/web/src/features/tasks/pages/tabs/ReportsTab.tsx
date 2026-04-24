/**
 * Reports tab — list of AI-generated reports for the current task.
 *
 * Phase 11 Step 2: replaces the placeholder stub. Backend is
 * `implementation-plan-phase11-report-skills.md`.
 *
 * Flow:
 *   1. Show existing reports (from GET /tasks/:id/reports).
 *   2. "Generate Report" button → opens skill picker → POST /generate.
 *   3. While status=generating: show spinner + auto-refresh via SSE
 *      (useNotifications invalidates ["task", id] + ["reports", id]).
 *   4. Completed: preview primary file inline (md/html/json/pdf), with
 *      download-bundle button for the full tarball.
 *   5. Failed: show failure_reason + retry.
 */

import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type Task,
  type ReportSkill,
  type UserReport,
} from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";
import { Icon } from "../../../../shared/components/Icon.js";
import { Markdown } from "../../../chat/components/Markdown.js";
import { formatDateTime } from "../../../../shared/utils/format.js";

export function ReportsTab() {
  const { task } = useOutletContext<{ task: Task }>();
  const qc = useQueryClient();
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [showSkillPicker, setShowSkillPicker] = useState(false);

  const { data: reportsData, isLoading } = useQuery({
    queryKey: ["reports", task.id],
    queryFn: () => api.reports.list(task.id),
  });

  const { data: skillsData } = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.skills.list(),
  });

  const generateMut = useMutation({
    mutationFn: (skillId: string) =>
      api.reports.generate(task.id, { skill_id: skillId }),
    onSuccess: ({ report }) => {
      qc.invalidateQueries({ queryKey: ["reports", task.id] });
      setSelectedReportId(report.id);
      setShowSkillPicker(false);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (reportId: string) => api.reports.delete(task.id, reportId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reports", task.id] });
      if (selectedReportId)
        setSelectedReportId(null);
    },
  });

  const reports = reportsData?.reports ?? [];
  const skills = skillsData?.skills ?? [];
  const selectedReport = reports.find((r) => r.id === selectedReportId);
  const canGenerate =
    task.state === "completed" || task.state === "failed"; // allow regen on failed

  return (
    <div
      data-testid="task-detail-panel-reports"
      style={{
        display: "flex",
        flex: 1,
        minHeight: 0,
        height: "100%",
      }}
    >
      {/* ──────────────────── Report list column ──────────────────── */}
      <div
        style={{
          width: "280px",
          flexShrink: 0,
          overflow: "hidden",
          borderRight: "1px solid var(--border)",
          background: "var(--bg-page)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "14px 16px",
            borderBottom: "1px solid var(--divider)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
          }}
        >
          <span
            style={{
              fontSize: "13px",
              fontWeight: 600,
              color: "var(--text-primary)",
            }}
          >
            {i18n.t("reports.title")}{" "}
            <span
              style={{
                fontSize: "12px",
                color: "var(--text-secondary)",
                fontWeight: 400,
                marginLeft: "4px",
              }}
            >
              ({reports.length})
            </span>
          </span>
          <button
            type="button"
            data-testid="reports-generate-btn"
            disabled={!canGenerate || skills.length === 0}
            onClick={() => setShowSkillPicker(true)}
            title={
              !canGenerate
                ? i18n.t("reports.needsCompleted")
                : skills.length === 0
                  ? i18n.t("reports.noSkills")
                  : undefined
            }
            style={{
              padding: "6px 12px",
              border: "none",
              borderRadius: "6px",
              background: canGenerate && skills.length > 0
                ? "var(--brand)"
                : "var(--bg-disabled)",
              color: "var(--btn-primary-text)",
              fontSize: "12px",
              fontWeight: 600,
              cursor:
                canGenerate && skills.length > 0 ? "pointer" : "not-allowed",
              opacity: canGenerate && skills.length > 0 ? 1 : 0.6,
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
            }}
          >
            <Icon name="plus" size={13} strokeWidth={2.5} />
            {i18n.t("reports.generate")}
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "6px" }}>
          {isLoading ? (
            <Empty text={i18n.t("reports.loading")} />
          ) : reports.length === 0 ? (
            <Empty
              text={
                canGenerate
                  ? i18n.t("reports.emptyPrompt")
                  : i18n.t("reports.needsCompleted")
              }
            />
          ) : (
            reports.map((r) => (
              <ReportRow
                key={r.id}
                report={r}
                active={r.id === selectedReportId}
                onClick={() => setSelectedReportId(r.id)}
                onDelete={() => {
                  if (
                    window.confirm(
                      i18n
                        .t("reports.deleteConfirm")
                        .replace("{name}", r.skill_name || r.id.slice(0, 8)),
                    )
                  )
                    deleteMut.mutate(r.id);
                }}
              />
            ))
          )}
        </div>
      </div>

      {/* ──────────────────── Preview column ──────────────────── */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {selectedReport ? (
          <ReportPreview
            report={selectedReport}
            taskId={task.id}
            onClose={() => setSelectedReportId(null)}
          />
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "10px",
              color: "var(--text-secondary)",
            }}
          >
            <Icon name="file-text" size={32} style={{ opacity: 0.35 }} />
            <span style={{ fontSize: "13px" }}>
              {i18n.t("reports.selectPrompt")}
            </span>
          </div>
        )}
      </div>

      {/* Skill picker modal */}
      {showSkillPicker && (
        <SkillPickerModal
          skills={skills}
          onPick={(skillId) => generateMut.mutate(skillId)}
          onClose={() => setShowSkillPicker(false)}
          pending={generateMut.isPending}
        />
      )}
    </div>
  );
}

/* ─────────────────────────── Sub-components ─────────────────────────── */

function Empty({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: "40px 20px",
        textAlign: "center",
        color: "var(--text-secondary)",
        fontSize: "13px",
      }}
    >
      {text}
    </div>
  );
}

function ReportRow({
  report,
  active,
  onClick,
  onDelete,
}: {
  report: UserReport;
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      data-testid="report-row"
      data-report-id={report.id}
      data-status={report.status}
      onClick={onClick}
      style={{
        padding: "10px 12px",
        borderRadius: "6px",
        cursor: "pointer",
        background: active ? "var(--bg-active-filter)" : "transparent",
        border: `1px solid ${active ? "var(--brand)" : "transparent"}`,
        marginBottom: "2px",
      }}
      onMouseEnter={(e) => {
        if (!active)
          (e.currentTarget as HTMLDivElement).style.background =
            "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active)
          (e.currentTarget as HTMLDivElement).style.background = "transparent";
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: "4px",
        }}
      >
        <StatusDot status={report.status} />
        <span
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--text-primary)",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {report.skill_name || report.id.slice(0, 8)}
        </span>
        <button
          type="button"
          data-testid="report-delete-btn"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title={i18n.t("reports.delete")}
          style={{
            width: "22px",
            height: "22px",
            border: "none",
            borderRadius: "4px",
            background: "transparent",
            color: "var(--text-secondary)",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: 0.6,
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = "var(--bg-hover)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = "transparent")
          }
        >
          <Icon name="x" size={13} />
        </button>
      </div>
      <div
        style={{
          fontSize: "11px",
          color: "var(--text-secondary)",
          display: "flex",
          gap: "8px",
          flexWrap: "wrap",
        }}
      >
        <span>{i18n.t(`reports.status.${report.status}`)}</span>
        {report.format && <span>· {report.format.toUpperCase()}</span>}
        <span>· {formatDateTime(report.created_at)}</span>
      </div>
      {report.status === "failed" && report.failure_reason && (
        <div
          style={{
            marginTop: "6px",
            fontSize: "11px",
            color: "var(--brand)",
            fontFamily: "'SF Mono', Menlo, Consolas, monospace",
            wordBreak: "break-word",
          }}
        >
          {report.failure_reason}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: UserReport["status"] }) {
  const color =
    status === "completed"
      ? "var(--status-completed, #22c55e)"
      : status === "failed"
        ? "var(--brand)"
        : "var(--status-running, #3b82f6)";
  return (
    <span
      aria-hidden
      style={{
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        animation:
          status === "generating"
            ? "vh-caret-blink 1.2s steps(2) infinite"
            : undefined,
      }}
    />
  );
}

function ReportPreview({
  report,
  taskId,
  onClose,
}: {
  report: UserReport;
  taskId: string;
  onClose: () => void;
}) {
  return (
    <div
      data-testid="report-preview"
      style={{
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        flex: 1,
      }}
    >
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--divider)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: "13px",
              fontWeight: 600,
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {report.skill_name || report.id.slice(0, 8)}
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
            {i18n.t(`reports.status.${report.status}`)}
            {report.format ? ` · ${report.format.toUpperCase()}` : ""}
          </div>
        </div>
        {report.status === "completed" && (
          <a
            href={api.reports.downloadUrl(taskId, report.id)}
            download
            data-testid="report-download-btn"
            style={{
              padding: "6px 12px",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              background: "var(--bg-card)",
              color: "var(--text-primary)",
              fontSize: "12px",
              fontWeight: 600,
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
            }}
          >
            <Icon name="file-text" size={13} />
            {i18n.t("reports.download")}
          </a>
        )}
        <button
          type="button"
          onClick={onClose}
          title={i18n.t("common.close")}
          style={{
            width: "28px",
            height: "28px",
            border: "none",
            borderRadius: "5px",
            background: "transparent",
            color: "var(--text-secondary)",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="x" size={15} />
        </button>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        <ReportBody report={report} taskId={taskId} />
      </div>
    </div>
  );
}

function ReportBody({
  report,
  taskId,
}: {
  report: UserReport;
  taskId: string;
}) {
  if (report.status === "generating") {
    return (
      <div
        data-testid="report-generating"
        style={{
          padding: "60px 20px",
          textAlign: "center",
          color: "var(--text-secondary)",
        }}
      >
        <div
          style={{
            fontSize: "14px",
            marginBottom: "6px",
            fontWeight: 500,
            color: "var(--text-primary)",
          }}
        >
          {i18n.t("reports.generating")}
        </div>
        <div style={{ fontSize: "12px" }}>{i18n.t("reports.takesMinutes")}</div>
      </div>
    );
  }
  if (report.status === "failed") {
    return (
      <div
        data-testid="report-failed"
        style={{
          padding: "40px 24px",
          color: "var(--brand)",
          fontSize: "13px",
          lineHeight: 1.6,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: "8px" }}>
          {i18n.t("reports.failed")}
        </div>
        <pre
          style={{
            fontFamily: "'SF Mono', Menlo, Consolas, monospace",
            fontSize: "12px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "var(--bg-error)",
            padding: "12px",
            borderRadius: "6px",
            border: "1px solid rgba(220,38,38,0.28)",
          }}
        >
          {report.failure_reason || "unknown error"}
        </pre>
      </div>
    );
  }
  // completed
  const fileUrl = api.reports.fileUrl(taskId, report.id);
  const format = (report.format ?? "").toLowerCase();
  if (format === "md" || format === "markdown") {
    return <MarkdownPreview url={fileUrl} />;
  }
  if (format === "html") {
    return (
      <iframe
        data-testid="report-iframe"
        src={fileUrl}
        sandbox="allow-same-origin"
        style={{ width: "100%", height: "100%", border: "none" }}
      />
    );
  }
  if (format === "json") {
    return <TextPreview url={fileUrl} monospace />;
  }
  if (format === "pdf") {
    return (
      <iframe
        data-testid="report-iframe"
        src={fileUrl}
        style={{ width: "100%", height: "100%", border: "none" }}
      />
    );
  }
  // Binary / unknown — just offer download.
  return (
    <div style={{ padding: "40px 20px", textAlign: "center" }}>
      <div
        style={{
          fontSize: "13px",
          color: "var(--text-secondary)",
          marginBottom: "12px",
        }}
      >
        {i18n.t("reports.noInlinePreview")}
      </div>
      <a
        href={api.reports.downloadUrl(taskId, report.id)}
        download
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "8px 14px",
          background: "var(--brand)",
          color: "var(--btn-primary-text)",
          borderRadius: "6px",
          textDecoration: "none",
          fontSize: "13px",
          fontWeight: 600,
        }}
      >
        <Icon name="file-text" size={14} />
        {i18n.t("reports.download")}
      </a>
    </div>
  );
}

function MarkdownPreview({ url }: { url: string }) {
  const { data } = useQuery({
    queryKey: ["report-file", url],
    queryFn: () => fetch(url, { credentials: "include" }).then((r) => r.text()),
  });
  return (
    <div style={{ padding: "18px 24px", fontSize: "14px", lineHeight: 1.7 }}>
      {data ? <Markdown content={data} /> : null}
    </div>
  );
}

function TextPreview({ url, monospace }: { url: string; monospace?: boolean }) {
  const { data } = useQuery({
    queryKey: ["report-file", url],
    queryFn: () => fetch(url, { credentials: "include" }).then((r) => r.text()),
  });
  return (
    <pre
      style={{
        margin: 0,
        padding: "18px 24px",
        fontSize: monospace ? "12.5px" : "13px",
        fontFamily: monospace
          ? "'SF Mono', Menlo, Consolas, monospace"
          : "inherit",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        color: "var(--text-primary)",
      }}
    >
      {data ?? ""}
    </pre>
  );
}

function SkillPickerModal({
  skills,
  onPick,
  onClose,
  pending,
}: {
  skills: ReportSkill[];
  onPick: (skillId: string) => void;
  onClose: () => void;
  pending: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(
    skills[0]?.id ?? null,
  );
  return (
    <div
      data-testid="report-skill-picker"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)",
          borderRadius: "10px",
          width: "min(440px, 90vw)",
          maxHeight: "80vh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--divider)",
            fontSize: "14px",
            fontWeight: 600,
          }}
        >
          {i18n.t("reports.pickSkillTitle")}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
          {skills.map((s) => (
            <label
              key={s.id}
              style={{
                display: "block",
                padding: "10px 12px",
                borderRadius: "6px",
                cursor: "pointer",
                background:
                  selected === s.id ? "var(--bg-active-filter)" : "transparent",
                border: `1px solid ${selected === s.id ? "var(--brand)" : "transparent"}`,
                marginBottom: "4px",
              }}
            >
              <input
                type="radio"
                name="skill"
                value={s.id}
                checked={selected === s.id}
                onChange={() => setSelected(s.id)}
                style={{ marginRight: "10px" }}
              />
              <span
                style={{
                  fontSize: "13px",
                  fontWeight: 600,
                  color: "var(--text-primary)",
                }}
              >
                {s.name}
              </span>
              {s.description && (
                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--text-secondary)",
                    marginTop: "2px",
                    marginLeft: "22px",
                  }}
                >
                  {s.description}
                </div>
              )}
            </label>
          ))}
        </div>
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--divider)",
            display: "flex",
            gap: "8px",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            style={{
              padding: "7px 14px",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              background: "var(--bg-card)",
              color: "var(--text-primary)",
              fontSize: "12px",
              fontWeight: 500,
              cursor: pending ? "not-allowed" : "pointer",
            }}
          >
            {i18n.t("common.cancel")}
          </button>
          <button
            type="button"
            data-testid="report-skill-pick-confirm"
            disabled={!selected || pending}
            onClick={() => selected && onPick(selected)}
            style={{
              padding: "7px 14px",
              border: "none",
              borderRadius: "6px",
              background: selected ? "var(--brand)" : "var(--bg-disabled)",
              color: "var(--btn-primary-text)",
              fontSize: "12px",
              fontWeight: 600,
              cursor: !selected || pending ? "not-allowed" : "pointer",
              opacity: !selected ? 0.6 : 1,
            }}
          >
            {pending ? i18n.t("reports.generating") : i18n.t("reports.generate")}
          </button>
        </div>
      </div>
    </div>
  );
}
