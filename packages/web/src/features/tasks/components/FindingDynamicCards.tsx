/**
 * Finding three dynamic cards (静态分析 / 动态验证 POC / 影响力评估) per the
 * SSOT (design-spec-finding-three-card-ssot-v1.0.md) and PRD §2. Data comes
 * from the H4 artifact read API; state from FindingDynamicMeta on the finding.
 * All artifact previews are read-only — no execution, no download.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type FindingMeta, type FindingArtifactGroups, type ArtifactFileEntry, type ArtifactFilePreview } from "../../../shared/api/client";
import { i18n } from "../../../shared/i18n";
import { Icon } from "../../../shared/components/Icon";
import { Markdown } from "../../chat/components/Markdown";
import {
  POC_STATE_DISPLAY,
  EXP_STATE_DISPLAY,
  resolvePocCardState,
  resolveExpCardState,
  showIncompleteBanner,
  type CardIcon,
} from "./finding-card-state";
import type { PocStatus, ExpStatus } from "@vulnagent/shared";

const CARD_STYLE: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "8px",
  padding: "12px 14px",
  marginBottom: "12px",
  background: "var(--bg-card)",
};

function StateBadge({ color, icon, label }: { color: string; icon: CardIcon; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: 600, color }}>
      <Icon name={icon as never} size={12} strokeWidth={2.5} />
      {label}
    </span>
  );
}

/** Read-only artifact file list + preview (no execution / no download). */
function ArtifactFileList({ taskId, files, defaultPreviewPath }: { taskId: string; files: ArtifactFileEntry[]; defaultPreviewPath?: string }) {
  const [selected, setSelected] = useState<string | null>(defaultPreviewPath ?? null);
  const previewable = files.filter((f) => f.previewable);
  const active = selected ?? previewable[0]?.path ?? null;
  const { data: preview } = useQuery<ArtifactFilePreview>({
    queryKey: ["artifact-file", taskId, active],
    queryFn: () => api.tasks.artifactFile(taskId, active!),
    enabled: !!active,
  });
  if (files.length === 0) {
    return <div style={{ fontSize: "12px", color: "var(--text-secondary)", opacity: 0.7 }}>{i18n.t("finding.cards.noArtifacts")}</div>;
  }
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" }}>
        {files.map((f) => (
          <button
            key={f.path}
            type="button"
            disabled={!f.previewable}
            onClick={() => f.previewable && setSelected(f.path)}
            title={f.path}
            style={{
              fontSize: "11px",
              padding: "3px 8px",
              borderRadius: "6px",
              border: `1px solid ${active === f.path ? "var(--brand)" : "var(--border)"}`,
              background: active === f.path ? "var(--bg-error)" : "transparent",
              color: f.previewable ? "var(--text-primary)" : "var(--text-secondary)",
              cursor: f.previewable ? "pointer" : "not-allowed",
              opacity: f.previewable ? 1 : 0.6,
              maxWidth: "220px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {f.path.split("/").pop()}
          </button>
        ))}
      </div>
      {active && preview?.kind === "text" && preview.content !== undefined ? (
        <div style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "10px 12px", background: "var(--bg-page)", maxHeight: "360px", overflow: "auto" }}>
          {active.endsWith(".md") ? (
            <Markdown content={preview.content} />
          ) : (
            <pre style={{ margin: 0, fontSize: "12px", fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{preview.content}</pre>
          )}
          {preview.truncated ? <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "6px" }}>{i18n.t("finding.cards.truncated")}</div> : null}
        </div>
      ) : active && preview?.kind === "image" && preview.data_base64 ? (
        <img src={`data:${preview.mime ?? "image/png"};base64,${preview.data_base64}`} alt={active} style={{ maxWidth: "100%", borderRadius: "6px", border: "1px solid var(--border)" }} />
      ) : active ? (
        <div style={{ fontSize: "12px", color: "var(--text-secondary)", opacity: 0.7 }}>{i18n.t("finding.cards.binaryNoPreview")}</div>
      ) : null}
    </div>
  );
}

function DynamicCard({
  titleKey,
  derived,
  derivedLabelKey,
  status,
  displayMap,
  showIncomplete,
  children,
}: {
  titleKey: string;
  derived: "not_enabled" | "env_lost" | null;
  derivedLabelKey: string;
  status: PocStatus | ExpStatus;
  displayMap: Record<string, { labelKey: string; color: string; icon: CardIcon; helperKey: string }>;
  showIncomplete: boolean;
  children: React.ReactNode;
}) {
  const display = displayMap[status];
  return (
    <div style={{ ...CARD_STYLE, ...(derived === "not_enabled" ? { borderStyle: "dashed", opacity: 0.75 } : {}) }} data-testid={`finding-card-${titleKey}`}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
        <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {i18n.t(`finding.cards.${titleKey}.title`)}
        </span>
        {derived ? (
          <StateBadge color={derived === "env_lost" ? "#dc2626" : "#737373"} icon="clock" label={i18n.t(`finding.cards.${derivedLabelKey}`)} />
        ) : display ? (
          <StateBadge color={display.color} icon={display.icon} label={i18n.t(`finding.cards.status.${display.labelKey}`)} />
        ) : null}
      </div>
      {showIncomplete ? (
        <div style={{ fontSize: "12px", color: "#ca8a04", background: "rgba(202,138,4,0.08)", border: "1px solid rgba(202,138,4,0.3)", borderRadius: "6px", padding: "6px 10px", marginBottom: "8px" }}>
          {i18n.t("finding.cards.incomplete")}
        </div>
      ) : null}
      {!derived && display ? (
        <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "8px" }}>
          {i18n.t(`finding.cards.helper.${display.helperKey}`)}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function FindingDynamicCards({ taskId, finding, dynamicEnabled }: { taskId: string; finding: FindingMeta; dynamicEnabled: boolean }) {
  const findingId = finding.finding_key;
  const { data: groups } = useQuery<FindingArtifactGroups>({
    queryKey: ["finding-artifacts", taskId, findingId],
    queryFn: () => api.findings.artifacts(taskId, findingId),
    enabled: dynamicEnabled,
  });

  const pocStatus = finding.poc_status;
  const expStatus = finding.exp_status;
  const poc = resolvePocCardState({ dynamicEnabled, pocStatus });
  const exp = resolveExpCardState({ dynamicEnabled, pocStatus, expStatus });

  const pocFiles = groups?.poc.files ?? [];
  const expFiles = groups?.exp.files ?? [];
  const pocDefault = pocFiles.find((f) => f.path.endsWith("/poc.md") || f.path.endsWith("poc.md"))?.path;
  const expDefault = expFiles.find((f) => f.path.endsWith("/exp.md") || f.path.endsWith("exp.md"))?.path;

  return (
    <div data-testid="finding-dynamic-cards" style={{ marginTop: "16px" }}>
      {showDowngradeBannerVisible(expStatus) ? (
        <div style={{ fontSize: "12px", color: "#2563eb", background: "rgba(37,99,235,0.08)", border: "1px solid rgba(37,99,235,0.3)", borderRadius: "6px", padding: "8px 10px", marginBottom: "12px" }}>
          {i18n.t("finding.cards.downgradeBanner")}
        </div>
      ) : null}

      {/* Static analysis card — constant "已确认" */}
      <div style={CARD_STYLE} data-testid="finding-card-static">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
          <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {i18n.t("finding.cards.static.title")}
          </span>
          <StateBadge color="#2563eb" icon="check-circle" label={i18n.t("finding.cards.static.confirmed")} />
        </div>
        <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
          {finding.finding_class === "risk" ? i18n.t("finding.cards.static.helperRisk") : i18n.t("finding.cards.static.helper")}
        </div>
      </div>

      {/* POC card */}
      <DynamicCard
        titleKey="poc"
        derived={poc.derived}
        derivedLabelKey={poc.derived === "env_lost" ? "envLost" : "notEnabled"}
        status={poc.status}
        displayMap={POC_STATE_DISPLAY}
        showIncomplete={showIncompleteBanner(dynamicEnabled, poc.status)}
      >
        {poc.derived === "not_enabled" ? null : (
          <ArtifactFileList taskId={taskId} files={pocFiles} defaultPreviewPath={pocDefault} />
        )}
      </DynamicCard>

      {/* EXP card */}
      <DynamicCard
        titleKey="exp"
        derived={exp.derived}
        derivedLabelKey={exp.derived === "env_lost" ? "envLost" : "notEnabled"}
        status={exp.status}
        displayMap={EXP_STATE_DISPLAY}
        showIncomplete={showIncompleteBanner(dynamicEnabled, exp.status)}
      >
        {exp.derived === "not_enabled" ? null : (
          <ArtifactFileList taskId={taskId} files={expFiles} defaultPreviewPath={expDefault} />
        )}
      </DynamicCard>
    </div>
  );
}

function showDowngradeBannerVisible(expStatus: ExpStatus | null): boolean {
  return expStatus === "downgraded";
}
