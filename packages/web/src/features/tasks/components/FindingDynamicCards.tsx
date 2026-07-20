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
      <Icon name={icon} size={12} strokeWidth={2.5} />
      {label}
    </span>
  );
}

/** Read-only artifact file list + preview (no execution / no download). */
function formatArtifactSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactBadge(path: string): string {
  const ext = path.split(".").pop()?.toUpperCase() ?? "FILE";
  return ext.length <= 3 ? ext : ext.slice(0, 3);
}

/** Read-only main preview + prototype-style artifact file list. */
function ArtifactFileList({ taskId, files, defaultPreviewPath, pathPrefix = "" }: { taskId: string; files: ArtifactFileEntry[]; defaultPreviewPath?: string; pathPrefix?: string }) {
  const [selected, setSelected] = useState<string | null>(defaultPreviewPath ?? null);
  const previewable = files.filter((f) => f.previewable);
  const active = selected ?? previewable[0]?.path ?? null;
  const activeFull = active ? `${pathPrefix}${active}` : null;
  const { data: preview, isLoading } = useQuery<ArtifactFilePreview>({
    queryKey: ["artifact-file", taskId, activeFull],
    queryFn: () => api.tasks.artifactFile(taskId, activeFull!),
    enabled: !!activeFull,
  });
  if (files.length === 0) {
    return <div style={{ fontSize: "12px", color: "var(--text-secondary)", opacity: 0.7 }}>{i18n.t("finding.cards.noArtifacts")}</div>;
  }
  return (
    <div>
      <div style={{ border: "1px solid var(--border)", borderRadius: "8px", background: "var(--bg-card)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "7px 10px", borderBottom: "1px solid var(--divider)", background: "var(--bg-page)", fontSize: "11px", fontWeight: 700 }}>
          <span style={{ width: "22px", height: "22px", borderRadius: "5px", display: "grid", placeItems: "center", background: "rgba(37,99,235,0.1)", color: "#2563eb", fontSize: "9px" }}>{active ? artifactBadge(active) : "MD"}</span>
          {active?.split("/").pop() ?? i18n.t("finding.cards.noArtifacts")}
          <span style={{ marginLeft: "auto", color: "var(--text-secondary)", fontSize: "9.5px", fontWeight: 600 }}>{i18n.t("finding.cards.mainPreview")}</span>
        </div>
        <div style={{ padding: "10px 12px", maxHeight: "360px", overflow: "auto" }}>
          {isLoading ? (
            <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{i18n.t("expPage.loadingDoc")}</div>
          ) : active && preview?.kind === "text" && preview.content !== undefined ? (
            active.endsWith(".md") ? <Markdown content={preview.content} /> : <pre style={{ margin: 0, fontSize: "12px", fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{preview.content}</pre>
          ) : active && preview?.kind === "image" && preview.data_base64 ? (
            <img src={`data:${preview.mime ?? "image/png"};base64,${preview.data_base64}`} alt={active} style={{ maxWidth: "100%", borderRadius: "6px" }} />
          ) : (
            <div style={{ fontSize: "12px", color: "var(--text-secondary)", opacity: 0.7 }}>{i18n.t("finding.cards.binaryNoPreview")}</div>
          )}
          {preview?.truncated ? <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "6px" }}>{i18n.t("finding.cards.truncated")}</div> : null}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "5px", marginTop: "8px" }}>
        {files.map((f) => {
          const isActive = active === f.path;
          return (
            <div key={f.path} style={{ display: "flex", alignItems: "center", gap: "8px", border: "1px solid var(--border)", borderRadius: "7px", background: "var(--bg-card)", padding: "7px 9px" }}>
              <span style={{ width: "26px", height: "26px", borderRadius: "6px", display: "grid", placeItems: "center", background: "var(--bg-page)", color: "#2563eb", fontSize: "9px", fontWeight: 800, flexShrink: 0 }}>{artifactBadge(f.path)}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: "11.5px", fontWeight: 650, wordBreak: "break-word" }}>{f.path.split("/").pop()}</div>
                <div style={{ fontSize: "10px", color: "var(--text-secondary)", marginTop: "1px" }}>{f.kind} · {formatArtifactSize(f.size)}</div>
              </div>
              <button type="button" disabled={!f.previewable} onClick={() => f.previewable && setSelected(f.path)} style={{ flexShrink: 0, border: `1px solid ${isActive ? "var(--brand)" : "var(--border)"}`, background: isActive ? "var(--brand)" : "var(--bg-card)", color: isActive ? "#fff" : "var(--text-primary)", borderRadius: "5px", padding: "3px 8px", fontSize: "10px", cursor: f.previewable ? "pointer" : "not-allowed", opacity: f.previewable ? 1 : 0.55 }}>
                {i18n.t("finding.cards.preview")}
              </button>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: "7px", alignItems: "flex-start", background: "rgba(202,138,4,0.08)", border: "1px solid rgba(202,138,4,0.3)", color: "#92400e", borderRadius: "7px", padding: "7px 9px", fontSize: "10.8px", lineHeight: 1.5, marginTop: "8px" }}>
        <Icon name="lock" size={12} /> {i18n.t("finding.cards.readOnlyNote")}
      </div>
    </div>
  );
}

function RiskSkipCard({ titleKey }: { titleKey: "poc" | "exp" }) {
  return (
    <div style={{ ...CARD_STYLE, borderStyle: "dashed" }} data-testid={`finding-card-${titleKey}`}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
        <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {i18n.t(`finding.cards.${titleKey}.title`)}
        </span>
        <StateBadge color="#737373" icon="minus-circle" label={i18n.t(`finding.cards.${titleKey}.riskSkipLabel`)} />
      </div>
      <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "8px" }}>
        {i18n.t(`finding.cards.${titleKey}.riskSkipHelper`)}
      </div>
      <div style={{ border: "1px dashed var(--border)", borderRadius: "8px", background: "var(--bg-page)", padding: "12px", color: "var(--text-secondary)", fontSize: "11px" }}>
        {i18n.t("finding.cards.riskNoArtifacts")}
      </div>
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
      {derived === "not_enabled" ? (
        <div style={{ border: "1px dashed var(--border)", borderRadius: "8px", background: "var(--bg-card)", padding: "16px 14px", textAlign: "center" }}>
          <div style={{ fontSize: "12.5px", fontWeight: 700, marginBottom: "4px" }}>{i18n.t(`finding.cards.${titleKey}.notEnabledTitle`)}</div>
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", lineHeight: 1.55 }}>{i18n.t(`finding.cards.${titleKey}.notEnabledHint`)}</div>
        </div>
      ) : children}
    </div>
  );
}

export function FindingDynamicCards({ taskId, finding, dynamicEnabled }: { taskId: string; finding: FindingMeta; dynamicEnabled: boolean }) {
  const findingId = finding.finding_key;
  const isRisk = finding.item_type === "risk" || finding.finding_class === "risk";
  const { data: groups } = useQuery<FindingArtifactGroups>({
    queryKey: ["finding-artifacts", taskId, findingId],
    queryFn: () => api.findings.artifacts(taskId, findingId),
    enabled: dynamicEnabled && !isRisk,
  });

  const pocStatus = finding.poc_status;
  const expStatus = finding.exp_status;
  const poc = resolvePocCardState({ dynamicEnabled, pocStatus });
  const exp = resolveExpCardState({ dynamicEnabled, pocStatus, expStatus });

  const pocFiles = groups?.poc.files ?? [];
  const expFiles = groups?.exp.files ?? [];
  const pocDefault = pocFiles.find((f) => f.path.endsWith("/poc.md") || f.path.endsWith("poc.md"))?.path;
  const expDefault = expFiles.find((f) => f.path.endsWith("/exp.md") || f.path.endsWith("exp.md"))?.path;

  if (isRisk) {
    return (
      <div data-testid="finding-dynamic-cards" data-finding-class="risk" style={{ marginTop: "16px" }}>
        <RiskSkipCard titleKey="poc" />
        <RiskSkipCard titleKey="exp" />
      </div>
    );
  }

  return (
    <div data-testid="finding-dynamic-cards" data-finding-class="vulnerability" style={{ marginTop: "16px" }}>
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
          <ArtifactFileList taskId={taskId} files={pocFiles} defaultPreviewPath={pocDefault} pathPrefix={`findings/${findingId}/`} />
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
          <ArtifactFileList taskId={taskId} files={expFiles} defaultPreviewPath={expDefault} pathPrefix={`findings/${findingId}/`} />
        )}
      </DynamicCard>
    </div>
  );
}
