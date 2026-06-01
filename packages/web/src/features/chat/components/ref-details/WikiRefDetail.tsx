import { useEffect, useState } from "react";
import { api, type WikiPayload } from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";
import { Icon } from "../../../../shared/components/Icon.js";
import { Markdown } from "../Markdown.js";
import type { ChatReferenceArtifact } from "../../types.js";
import {
  DetailHeader,
  ErrorState,
  KvRow,
  LoadingState,
  NotFoundState,
  stringifySection,
} from "./shared.js";

type Tab = "profile" | "features" | "reports";

export function WikiRefDetail({ artifact }: { artifact: ChatReferenceArtifact }) {
  const initial =
    artifact.section === "features" || artifact.section === "reports"
      ? artifact.section
      : "profile";
  const [tab, setTab] = useState<Tab>(initial);
  const [data, setData] = useState<WikiPayload | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(false);
    api.tasks
      .wiki(artifact.task_id)
      .then((res) => mounted && setData(res))
      .catch(() => mounted && setError(true))
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, [artifact.task_id, nonce]);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState onRetry={() => setNonce((n) => n + 1)} />;
  if (!data) return <NotFoundState />;

  return (
    <div
      data-testid="ref-detail-wiki"
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <DetailHeader
        icon="book-open"
        color="var(--text-secondary)"
        title={artifact.title || "Wiki"}
        to={`/tasks/${artifact.task_id}/wiki`}
      />
      <div style={{ borderBottom: "1px solid var(--divider)", padding: "0 18px", display: "flex" }}>
        {(["profile", "features", "reports"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            data-testid={`ref-wiki-tab-${t}`}
            onClick={() => setTab(t)}
            style={{
              padding: "10px 16px",
              fontSize: 12,
              fontWeight: tab === t ? 600 : 500,
              color: tab === t ? "var(--text-primary)" : "var(--text-secondary)",
              border: "none",
              borderBottom: `2px solid ${tab === t ? "var(--brand)" : "transparent"}`,
              background: "transparent",
              cursor: "pointer",
            }}
          >
            {i18n.t(`chat.ref.wiki.${t}`)}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {tab === "profile" ? <ProfileTab data={data} /> : null}
        {tab === "features" ? <FeaturesTab data={data} /> : null}
        {tab === "reports" ? <ReportsTab data={data} /> : null}
      </div>
    </div>
  );
}

function ProfileTab({ data }: { data: WikiPayload }) {
  const profiler = data.profiler as any;
  if (!profiler) return <WikiEmpty />;
  return (
    <div style={{ padding: "8px 0" }}>
      <KvRow label="Language" value={profiler.language || profiler.primary_language || "—"} />
      <KvRow label="Build" value={profiler.build_system || profiler.packageManager || "—"} />
      <KvRow label="LOC" value={profiler.loc || profiler.total_loc || "—"} />
      <KvRow label="Files" value={profiler.file_count || profiler.total_files || "—"} />
    </div>
  );
}

function FeaturesTab({ data }: { data: WikiPayload }) {
  const features = data.features ?? [];
  if (features.length === 0) return <WikiEmpty />;
  return (
    <div>
      {features.slice(0, 20).map((feature: any, index) => {
        const payload = feature.payload ?? feature;
        return (
          <div
            key={`${payload.name ?? "feature"}-${index}`}
            style={{ padding: "8px 18px", borderBottom: "1px solid var(--divider)" }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              {payload.name || payload.title || `Feature ${index + 1}`}
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                marginTop: 2,
                lineHeight: 1.5,
              }}
            >
              {payload.description || payload.summary || stringifySection(payload).slice(0, 220)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ReportsTab({ data }: { data: WikiPayload }) {
  const report = data.reports?.[0] as any;
  const content = report?.content || report?.markdown || report?.body || "";
  if (!content) return <WikiEmpty />;
  return (
    <div style={{ padding: "14px 18px", fontSize: 13, lineHeight: 1.65 }}>
      <Markdown content={String(content)} />
    </div>
  );
}

function WikiEmpty() {
  return (
    <div
      style={{
        minHeight: 220,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        color: "var(--text-secondary)",
        textAlign: "center",
        padding: 24,
      }}
    >
      <Icon name="activity" size={24} style={{ opacity: 0.4 }} />
      <div style={{ fontSize: 13 }}>{i18n.t("chat.ref.wiki.notReady")}</div>
    </div>
  );
}
