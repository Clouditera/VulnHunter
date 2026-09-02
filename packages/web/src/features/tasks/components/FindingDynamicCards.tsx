import { useQuery } from "@tanstack/react-query";
import type { ExpStatus, PocStatus } from "@vulnhunter/shared";
/**
 * Finding detail stage cards + accordion artifact previews.
 * Spec: implementation-spec-finding-detail-redesign-v1.0.md
 *
 * Layout: each right-panel sub-tab owns exactly one stage card —
 *   漏洞详情 → StaticStatusCard
 *   动态验证 → FindingPocPanel (POC card + accordion files)
 *   可利用性评估 → FindingExpPanel (EXP card + accordion files)
 */
import { useState } from "react";
import {
  type ArtifactFileEntry,
  type ArtifactFilePreview,
  type FindingArtifactGroups,
  type FindingMeta,
  api,
} from "../../../shared/api/client";
import { Icon } from "../../../shared/components/Icon";
import { i18n } from "../../../shared/i18n";
import { Markdown } from "../../chat/components/Markdown";
import {
  type CardIcon,
  type CardStateDisplay,
  EXP_STATE_DISPLAY,
  POC_STATE_DISPLAY,
  resolveExpCardState,
  resolvePocCardState,
  showIncompleteBanner,
} from "./finding-card-state";

/** Unified status-card chrome (fish: thin border, radius 8, no shadow). */
export const STAGE_CARD_STYLE: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  padding: "12px 14px",
  marginBottom: "12px",
  width: "100%",
  boxSizing: "border-box",
};

function StateBadge({ color, icon, label }: { color: string; icon: CardIcon; label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        fontSize: "12px",
        fontWeight: 700,
        color,
      }}
    >
      <Icon name={icon} size={12} strokeWidth={2.5} />
      {label}
    </span>
  );
}

function formatArtifactSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactBadge(path: string): string {
  const ext = path.split(".").pop()?.toUpperCase() ?? "FILE";
  return ext.length <= 3 ? ext : ext.slice(0, 3);
}

/** Accordion: click file head to expand content inside the same card. Default all collapsed. */
function AccordionArtifactList({
  taskId,
  findingId,
  files,
  pathPrefix = "",
}: {
  taskId: string;
  findingId: string;
  files: ArtifactFileEntry[];
  pathPrefix?: string;
}) {
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());

  const toggle = (path: string, previewable: boolean) => {
    if (!previewable) return;
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (files.length === 0) {
    return (
      <div style={{ fontSize: "12px", color: "var(--text-secondary)", opacity: 0.7 }}>
        {i18n.t("finding.cards.noArtifacts")}
      </div>
    );
  }

  return (
    <div
      data-testid="finding-artifact-accordion"
      style={{ display: "flex", flexDirection: "column", gap: "6px" }}
    >
      {/* HALL-23: per-finding pack download — sits above the file rows so the
          entry is reachable without expanding anything. */}
      <a
        href={api.tasks.findingArtifactsDownloadUrl(taskId, findingId)}
        download
        data-testid="finding-artifacts-download-btn"
        title={i18n.t("finding.cards.downloadAll")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          alignSelf: "flex-start",
          padding: "4px 10px",
          border: "1px solid var(--border)",
          borderRadius: "6px",
          background: "var(--bg-card)",
          color: "var(--text-primary)",
          fontSize: "11px",
          fontWeight: 600,
          textDecoration: "none",
          cursor: "pointer",
        }}
      >
        <Icon name="download" size={12} strokeWidth={2} />
        {i18n.t("finding.cards.downloadAll")}
      </a>
      {files.map((f) => {
        const open = openPaths.has(f.path);
        const basename = f.path.split("/").pop() ?? f.path;
        return (
          <div
            key={f.path}
            data-testid={`finding-artifact-card-${basename}`}
            data-open={open || undefined}
            style={{
              border: `1px solid ${open ? "var(--brand)" : "var(--border)"}`,
              borderRadius: "8px",
              background: "var(--bg-card)",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "stretch" }}>
              <button
                type="button"
                disabled={!f.previewable}
                aria-expanded={open}
                onClick={() => toggle(f.path, f.previewable)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "9px 11px",
                  border: "none",
                  background: open ? "var(--bg-error)" : "transparent",
                  color: "var(--text-primary)",
                  textAlign: "left",
                  cursor: f.previewable ? "pointer" : "default",
                  opacity: f.previewable ? 1 : 0.55,
                }}
              >
                <span
                  style={{
                    width: "26px",
                    height: "26px",
                    borderRadius: "6px",
                    display: "grid",
                    placeItems: "center",
                    background: "var(--bg-page)",
                    color: "var(--brand)",
                    fontSize: "9px",
                    fontWeight: 800,
                    flexShrink: 0,
                  }}
                >
                  {artifactBadge(f.path)}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span
                    style={{
                      display: "block",
                      fontSize: "12px",
                      fontWeight: 600,
                      fontFamily: "ui-monospace, Menlo, monospace",
                      wordBreak: "break-word",
                    }}
                  >
                    {basename}
                  </span>
                  <span
                    style={{
                      display: "block",
                      fontSize: "10px",
                      color: "var(--text-secondary)",
                      marginTop: "1px",
                    }}
                  >
                    {f.kind} · {formatArtifactSize(f.size)}
                  </span>
                </span>
                {f.previewable ? (
                  <span
                    aria-hidden
                    style={{
                      fontSize: "14px",
                      color: "var(--text-secondary)",
                      transform: open ? "rotate(90deg)" : "none",
                      transition: "transform 0.12s",
                      flexShrink: 0,
                      lineHeight: 1,
                    }}
                  >
                    ›
                  </span>
                ) : null}
              </button>
              {/* HALL-23: single-file download — always offered, including
                non-previewable binary rows (the core ask of this feature). */}
              <a
                href={api.tasks.artifactFileDownloadUrl(taskId, `${pathPrefix}${f.path}`)}
                download
                data-testid={`finding-artifact-download-${basename}`}
                title={i18n.t("finding.cards.downloadFile")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "0 10px",
                  border: "none",
                  borderLeft: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  textDecoration: "none",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                <Icon name="download" size={13} strokeWidth={2} />
              </a>
            </div>
            {open ? (
              <AccordionBody taskId={taskId} path={`${pathPrefix}${f.path}`} fileName={f.path} />
            ) : null}
          </div>
        );
      })}
      <div
        style={{
          display: "flex",
          gap: "7px",
          alignItems: "flex-start",
          background: "rgba(202,138,4,0.08)",
          border: "1px solid rgba(202,138,4,0.3)",
          color: "#92400e",
          borderRadius: "7px",
          padding: "7px 9px",
          fontSize: "10.8px",
          lineHeight: 1.5,
          marginTop: "2px",
        }}
      >
        <Icon name="lock" size={12} /> {i18n.t("finding.cards.readOnlyNote")}
      </div>
    </div>
  );
}

function AccordionBody({
  taskId,
  path,
  fileName,
}: { taskId: string; path: string; fileName: string }) {
  const { data: preview, isLoading } = useQuery<ArtifactFilePreview>({
    queryKey: ["artifact-file", taskId, path],
    queryFn: () => api.tasks.artifactFile(taskId, path),
  });
  return (
    <div
      data-testid="finding-artifact-content"
      style={{
        borderTop: "1px solid var(--border)",
        padding: "12px 14px",
        background: "#fcfcfc",
        maxHeight: "420px",
        overflow: "auto",
      }}
    >
      {isLoading ? (
        <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
          {i18n.t("expPage.loadingDoc")}
        </div>
      ) : preview?.kind === "text" && preview.content !== undefined ? (
        fileName.endsWith(".md") ? (
          <Markdown content={preview.content} />
        ) : (
          <pre
            style={{
              margin: 0,
              fontSize: "12px",
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {preview.content}
          </pre>
        )
      ) : preview?.kind === "image" && preview.data_base64 ? (
        <img
          src={`data:${preview.mime ?? "image/png"};base64,${preview.data_base64}`}
          alt={fileName}
          style={{ maxWidth: "100%", borderRadius: "6px" }}
        />
      ) : (
        <div style={{ fontSize: "12px", color: "var(--text-secondary)", opacity: 0.7 }}>
          {i18n.t("finding.cards.binaryNoPreview")}
        </div>
      )}
      {preview?.truncated ? (
        <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "6px" }}>
          {i18n.t("finding.cards.truncated")}
        </div>
      ) : null}
    </div>
  );
}

/** Static-analysis-only card for the 漏洞详情 sub-tab. */
export function StaticStatusCard({ finding }: { finding: FindingMeta }) {
  const isRisk = finding.item_type === "risk" || finding.finding_class === "risk";
  return (
    <div style={STAGE_CARD_STYLE} data-testid="finding-card-static">
      <div
        style={{
          fontSize: "11.5px",
          fontWeight: 700,
          marginBottom: "6px",
          color: "var(--text-primary)",
        }}
      >
        {i18n.t("finding.cards.static.title")}
      </div>
      <div style={{ marginBottom: "4px" }}>
        <StateBadge
          color="var(--brand)"
          icon="check-circle"
          label={i18n.t("finding.cards.static.confirmed")}
        />
      </div>
      <div style={{ fontSize: "11px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
        {isRisk ? i18n.t("finding.cards.static.helperRisk") : i18n.t("finding.cards.static.helper")}
      </div>
    </div>
  );
}

function StageStatusCard({
  titleKey,
  testid,
  isRisk,
  derived,
  derivedLabelKey,
  status,
  displayMap,
  showIncomplete,
}: {
  titleKey: "poc" | "exp";
  testid: string;
  isRisk: boolean;
  derived: "not_enabled" | "env_lost" | "timed_out" | null;
  derivedLabelKey: string;
  status: PocStatus | ExpStatus;
  displayMap: Record<string, CardStateDisplay>;
  showIncomplete: boolean;
}) {
  if (isRisk) {
    return (
      <div style={{ ...STAGE_CARD_STYLE, borderStyle: "dashed" }} data-testid={testid}>
        <div style={{ fontSize: "11.5px", fontWeight: 700, marginBottom: "6px" }}>
          {i18n.t(`finding.cards.${titleKey}.title`)}
        </div>
        <div style={{ marginBottom: "4px" }}>
          <StateBadge
            color="#737373"
            icon="minus-circle"
            label={i18n.t(`finding.cards.${titleKey}.riskSkipLabel`)}
          />
        </div>
        <div style={{ fontSize: "11px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {i18n.t(`finding.cards.${titleKey}.riskSkipHelper`)}
        </div>
      </div>
    );
  }

  const display = displayMap[status];
  return (
    <div
      style={{
        ...STAGE_CARD_STYLE,
        ...(derived === "not_enabled" ? { borderStyle: "dashed" } : {}),
      }}
      data-testid={testid}
    >
      <div style={{ fontSize: "11.5px", fontWeight: 700, marginBottom: "6px" }}>
        {i18n.t(`finding.cards.${titleKey}.title`)}
      </div>
      <div style={{ marginBottom: "4px" }}>
        {derived ? (
          <StateBadge
            color={
              derived === "env_lost"
                ? "var(--danger)"
                : derived === "timed_out"
                  ? "var(--sev-medium)"
                  : "#737373"
            }
            icon="clock"
            label={i18n.t(`finding.cards.${derivedLabelKey}`)}
          />
        ) : display ? (
          <StateBadge
            color={display.color}
            icon={display.icon}
            label={i18n.t(`finding.cards.status.${display.labelKey}`)}
          />
        ) : null}
      </div>
      {showIncomplete ? (
        <div
          style={{
            fontSize: "12px",
            color: "var(--sev-medium)",
            background: "rgba(202,138,4,0.08)",
            border: "1px solid rgba(202,138,4,0.3)",
            borderRadius: "6px",
            padding: "6px 10px",
            marginBottom: "8px",
          }}
        >
          {i18n.t("finding.cards.incomplete")}
        </div>
      ) : null}
      {!derived && display ? (
        <div
          style={{
            fontSize: "11px",
            color: "var(--text-secondary)",
            lineHeight: 1.5,
            marginBottom: derived === "not_enabled" ? 0 : 0,
          }}
        >
          {i18n.t(`finding.cards.helper.${display.helperKey}`)}
        </div>
      ) : null}
      {derived === "not_enabled" ? (
        <div
          style={{
            fontSize: "11px",
            color: "var(--text-secondary)",
            lineHeight: 1.5,
            marginTop: "4px",
          }}
        >
          {i18n.t(`finding.cards.${titleKey}.notEnabledHint`)}
        </div>
      ) : null}
      {derived === "timed_out" ? (
        <div
          style={{
            fontSize: "11px",
            color: "var(--text-secondary)",
            lineHeight: 1.5,
            marginTop: "4px",
          }}
          data-testid={`${testid}-timeout-hint`}
        >
          {i18n.t("finding.cards.timedOutHint")}
        </div>
      ) : null}
    </div>
  );
}

function useFindingArtifacts(taskId: string, findingId: string, enabled: boolean) {
  return useQuery<FindingArtifactGroups>({
    queryKey: ["finding-artifacts", taskId, findingId],
    queryFn: () => api.findings.artifacts(taskId, findingId),
    enabled,
  });
}

/** 动态验证 sub-tab body. */
export function FindingPocPanel({
  taskId,
  finding,
  dynamicEnabled,
  timedOut = false,
}: {
  taskId: string;
  finding: FindingMeta;
  dynamicEnabled: boolean;
  timedOut?: boolean;
}) {
  const findingId = finding.finding_key;
  const isRisk = finding.item_type === "risk" || finding.finding_class === "risk";
  const poc = resolvePocCardState({ dynamicEnabled, pocStatus: finding.poc_status, timedOut });
  const { data: groups } = useFindingArtifacts(
    taskId,
    findingId,
    dynamicEnabled && !isRisk && poc.derived !== "not_enabled",
  );
  const files = groups?.poc.files ?? [];

  return (
    <div data-testid="finding-poc-panel" style={{ padding: "12px 16px" }}>
      <StageStatusCard
        titleKey="poc"
        testid="finding-card-poc"
        isRisk={isRisk}
        derived={poc.derived}
        derivedLabelKey={
          poc.derived === "env_lost"
            ? "envLost"
            : poc.derived === "timed_out"
              ? "timedOut"
              : "notEnabled"
        }
        status={poc.status}
        displayMap={POC_STATE_DISPLAY}
        showIncomplete={
          !isRisk && poc.derived == null && showIncompleteBanner(dynamicEnabled, poc.status)
        }
      />
      {isRisk || poc.derived === "not_enabled" ? (
        isRisk ? (
          <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
            {i18n.t("finding.cards.riskNoArtifacts")}
          </div>
        ) : null
      ) : (
        <AccordionArtifactList
          taskId={taskId}
          findingId={findingId}
          files={files}
          pathPrefix={`findings/${findingId}/`}
        />
      )}
    </div>
  );
}

/** 可利用性评估 sub-tab body. */
export function FindingExpPanel({
  taskId,
  finding,
  dynamicEnabled,
  timedOut = false,
}: {
  taskId: string;
  finding: FindingMeta;
  dynamicEnabled: boolean;
  timedOut?: boolean;
}) {
  const findingId = finding.finding_key;
  const isRisk = finding.item_type === "risk" || finding.finding_class === "risk";
  const exp = resolveExpCardState({
    dynamicEnabled,
    pocStatus: finding.poc_status,
    expStatus: finding.exp_status,
    timedOut,
  });
  const { data: groups } = useFindingArtifacts(
    taskId,
    findingId,
    dynamicEnabled && !isRisk && exp.derived !== "not_enabled",
  );
  const files = groups?.exp.files ?? [];

  return (
    <div data-testid="finding-exp-panel" style={{ padding: "12px 16px" }}>
      <StageStatusCard
        titleKey="exp"
        testid="finding-card-exp"
        isRisk={isRisk}
        derived={exp.derived}
        derivedLabelKey={
          exp.derived === "env_lost"
            ? "envLost"
            : exp.derived === "timed_out"
              ? "timedOut"
              : "notEnabled"
        }
        status={exp.status}
        displayMap={EXP_STATE_DISPLAY}
        showIncomplete={
          !isRisk && exp.derived == null && showIncompleteBanner(dynamicEnabled, exp.status)
        }
      />
      {isRisk || exp.derived === "not_enabled" ? (
        isRisk ? (
          <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
            {i18n.t("finding.cards.riskNoArtifacts")}
          </div>
        ) : null
      ) : (
        <AccordionArtifactList
          taskId={taskId}
          findingId={findingId}
          files={files}
          pathPrefix={`findings/${findingId}/`}
        />
      )}
    </div>
  );
}

export type TabStatusPill = {
  label: string;
  color: string;
  background: string;
  border: string;
};

const PILL_GREEN = {
  background: "#f0fdf4",
  color: "var(--status-completed)",
  border: "1px solid #bbf7d0",
};
const PILL_RED = {
  background: "var(--bg-error)",
  color: "var(--danger)",
  border: "1px solid var(--danger-border)",
};
const PILL_AMBER = { background: "#fffbeb", color: "#d97706", border: "1px solid #fde68a" };
const PILL_GRAY = {
  background: "var(--bg-page)",
  color: "var(--text-secondary)",
  border: "1px solid var(--border)",
};
const PILL_BLUE = { background: "#eff6ff", color: "var(--brand)", border: "1px solid #bfdbfe" };
const PILL_CYAN = { background: "#ecfeff", color: "#0891b2", border: "1px solid #a5f3fc" };

/** Compact status pill for sub-tab labels (动态验证 / 可利用性评估). */
export function resolvePocTabPill(finding: FindingMeta, dynamicEnabled: boolean): TabStatusPill {
  const isRisk = finding.item_type === "risk" || finding.finding_class === "risk";
  if (isRisk) {
    return { label: i18n.t("finding.cards.poc.riskSkipLabel"), ...PILL_GRAY };
  }
  const { derived, status } = resolvePocCardState({
    dynamicEnabled,
    pocStatus: finding.poc_status,
  });
  if (derived === "not_enabled") return { label: i18n.t("finding.cards.notEnabled"), ...PILL_GRAY };
  if (derived === "env_lost") return { label: i18n.t("finding.cards.envLost"), ...PILL_RED };
  switch (status) {
    case "reproduced":
      return { label: i18n.t("finding.cards.status.reproduced"), ...PILL_GREEN };
    case "fail-reproduced":
      return { label: i18n.t("finding.cards.status.failReproduced"), ...PILL_RED };
    case "blocked":
      return { label: i18n.t("finding.cards.status.blocked"), ...PILL_AMBER };
    case "not-needed":
      return { label: i18n.t("finding.cards.status.notNeeded"), ...PILL_CYAN };
    case "pending":
      return { label: i18n.t("finding.cards.status.pending"), ...PILL_GRAY };
    default:
      return { label: i18n.t("finding.cards.status.unknown"), ...PILL_GRAY };
  }
}

export function resolveExpTabPill(finding: FindingMeta, dynamicEnabled: boolean): TabStatusPill {
  const isRisk = finding.item_type === "risk" || finding.finding_class === "risk";
  if (isRisk) {
    return { label: i18n.t("finding.cards.exp.riskSkipLabel"), ...PILL_GRAY };
  }
  const { derived, status } = resolveExpCardState({
    dynamicEnabled,
    pocStatus: finding.poc_status,
    expStatus: finding.exp_status,
  });
  if (derived === "not_enabled") return { label: i18n.t("finding.cards.notEnabled"), ...PILL_GRAY };
  if (derived === "env_lost") return { label: i18n.t("finding.cards.envLost"), ...PILL_RED };
  switch (status) {
    case "confirmed":
      return { label: i18n.t("finding.cards.status.confirmed"), ...PILL_GREEN };
    case "downgraded":
      return { label: i18n.t("finding.cards.status.downgraded"), ...PILL_BLUE };
    case "failed":
      return { label: i18n.t("finding.cards.status.failed"), ...PILL_RED };
    case "blocked":
      return { label: i18n.t("finding.cards.status.blocked"), ...PILL_AMBER };
    case "not-needed":
      return { label: i18n.t("finding.cards.status.notNeededExp"), ...PILL_CYAN };
    case "awaiting-poc":
      return { label: i18n.t("finding.cards.status.awaitingPoc"), ...PILL_GRAY };
    case "pending":
      return { label: i18n.t("finding.cards.status.pendingExp"), ...PILL_GRAY };
    default:
      return { label: i18n.t("finding.cards.status.unknown"), ...PILL_GRAY };
  }
}
