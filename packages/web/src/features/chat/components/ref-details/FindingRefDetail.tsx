import { useEffect, useState } from "react";
import {
  api,
  type FindingDetail,
  type FindingMeta,
  type FindingReviewStatus,
} from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";
import { Markdown } from "../Markdown.js";
import type { ChatReferenceArtifact } from "../../types.js";
import {
  DetailHeader,
  ErrorState,
  LoadingState,
  NotFoundState,
  SECTION,
  severityColor,
  stringifySection,
  TITLE,
} from "./shared.js";

export function FindingRefDetail({ artifact }: { artifact: ChatReferenceArtifact }) {
  const [data, setData] = useState<{ meta: FindingMeta; detail: FindingDetail } | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const key = artifact.finding_key;

  useEffect(() => {
    if (!key) return;
    let mounted = true;
    setLoading(true);
    setError(false);
    api.findings
      .detail(artifact.task_id, key)
      .then((res) => mounted && setData(res))
      .catch(() => mounted && setError(true))
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, [artifact.task_id, key, nonce]);

  if (!key) return <NotFoundState />;
  if (loading) return <LoadingState />;
  if (error) return <ErrorState onRetry={() => setNonce((n) => n + 1)} />;
  if (!data) return <NotFoundState />;

  const { meta, detail } = data;
  const fileLine = `${meta.primary_file || "—"}${meta.primary_line ? `:${meta.primary_line}` : ""}`;
  const description = stringifySection(detail.description);
  const remediation = stringifySection(detail.remediation);

  async function updateReview(status: FindingReviewStatus) {
    const res = await api.findings.updateReview(artifact.task_id, meta.finding_key, {
      review_status: status,
    });
    setData((prev) => (prev ? { ...prev, meta: res.finding } : prev));
  }

  return (
    <div data-testid="ref-detail-finding" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
      <DetailHeader
        icon="alert-triangle"
        color={severityColor(meta.severity)}
        title={meta.vuln_type || meta.finding_key}
        to={`/tasks/${artifact.task_id}/findings`}
      />
      <div
        style={{
          padding: "0 18px 14px",
          borderBottom: "1px solid var(--divider)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11,
            fontWeight: 600,
            color: severityColor(meta.severity),
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: severityColor(meta.severity),
            }}
          />
          {meta.severity}
        </span>
        <span style={{ fontSize: 12, fontFamily: "monospace", color: "var(--text-secondary)" }}>
          {fileLine}
        </span>
      </div>
      <Section
        title={i18n.t("chat.ref.finding.description")}
        content={description}
        maxHeight={200}
      />
      <section style={SECTION}>
        <div style={TITLE}>{i18n.t("chat.ref.finding.code")}</div>
        <div
          style={{
            fontSize: 12,
            fontFamily: "monospace",
            color: "var(--text-primary)",
            background: "var(--code-bg, var(--bg-page))",
            padding: "6px 10px",
            borderRadius: 6,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {fileLine}
        </div>
        {meta.function_name ? (
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6 }}>
            function: <span style={{ fontFamily: "monospace" }}>{meta.function_name}</span>
          </div>
        ) : null}
      </section>
      <section style={{ ...SECTION, display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ ...TITLE, marginBottom: 0, flex: 1 }}>
          {i18n.t("chat.ref.finding.review")}
        </div>
        <select
          value={meta.review_status}
          onChange={(e) => void updateReview(e.target.value as FindingReviewStatus)}
          style={{
            fontSize: 12,
            borderRadius: 6,
            border: "1px solid var(--border)",
            padding: "5px 8px",
            background: "var(--bg-card)",
            color: "var(--text-primary)",
          }}
        >
          <option value="pending">pending</option>
          <option value="confirmed">confirmed</option>
          <option value="false_positive">false_positive</option>
          <option value="ignored">ignored</option>
        </select>
      </section>
      {remediation ? (
        <Section
          title={i18n.t("chat.ref.finding.remediation")}
          content={remediation}
          maxHeight={160}
          last
        />
      ) : null}
    </div>
  );
}

function Section({
  title,
  content,
  maxHeight,
  last,
}: { title: string; content: string; maxHeight: number; last?: boolean }) {
  if (!content) return null;
  return (
    <section style={{ ...SECTION, borderBottom: last ? "none" : SECTION.borderBottom }}>
      <div style={TITLE}>{title}</div>
      <div
        style={{
          fontSize: 13,
          color: "var(--text-primary)",
          lineHeight: 1.65,
          maxHeight,
          overflow: "auto",
        }}
      >
        <Markdown content={content} />
      </div>
    </section>
  );
}
