import { useEffect, useState } from "react";
import { api, type UserReport } from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";
import type { ChatReferenceArtifact } from "../../types.js";
import {
  DetailHeader,
  ErrorState,
  formatTime,
  LoadingState,
  NotFoundState,
  StatusPill,
} from "./shared.js";

export function ReportRefDetail({ artifact }: { artifact: ChatReferenceArtifact }) {
  const [report, setReport] = useState<UserReport | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const reportId = artifact.report_id;

  useEffect(() => {
    if (!reportId) return;
    let mounted = true;
    setLoading(true);
    setError(false);
    api.reports
      .get(artifact.task_id, reportId)
      .then((res) => mounted && setReport(res.report))
      .catch(() => mounted && setError(true))
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, [artifact.task_id, reportId, nonce]);

  if (!reportId) return <NotFoundState />;
  if (loading) return <LoadingState />;
  if (error) return <ErrorState onRetry={() => setNonce((n) => n + 1)} />;
  if (!report) return <NotFoundState />;

  const title = report.skill_name || artifact.title || "Report";
  const download = api.reports.downloadUrl(artifact.task_id, report.id);
  const preview = api.reports.fileUrl(artifact.task_id, report.id);

  return (
    <div
      data-testid="ref-detail-report"
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <DetailHeader
        icon="file-text"
        color="var(--status-completed)"
        title={title}
        action={
          <a
            href={download}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              background: "var(--brand)",
              color: "#fff",
              border: "none",
              cursor: "pointer",
              textDecoration: "none",
            }}
          >
            {i18n.t("chat.ref.report.download")}
          </a>
        }
      />
      <div
        style={{
          padding: "0 18px 12px",
          borderBottom: "1px solid var(--divider)",
          display: "flex",
          gap: 16,
          alignItems: "center",
          fontSize: 12,
          color: "var(--text-secondary)",
        }}
      >
        <span>
          Status: <StatusPill value={report.status} />
        </span>
        <span>Created: {formatTime(report.created_at)}</span>
      </div>
      <div style={{ flex: 1, padding: "14px 18px", minHeight: 0 }}>
        {report.status === "generating" ? (
          <div
            style={{
              height: "100%",
              minHeight: 260,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-secondary)",
              fontSize: 13,
            }}
          >
            {i18n.t("chat.ref.report.generating")}
          </div>
        ) : (
          <iframe
            data-testid="ref-report-preview"
            title={title}
            sandbox=""
            src={preview}
            style={{
              width: "100%",
              height: "100%",
              minHeight: 400,
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "#fff",
            }}
          />
        )}
      </div>
    </div>
  );
}
