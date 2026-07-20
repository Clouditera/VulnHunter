/**
 * Finding stage rail — a compact 3-column summary (静态分析 / 动态验证 POC /
 * 影响力评估) shown at the top of the Finding detail panel, immediately below
 * the review-status row. Mirrors prototype-finding-detail-dynamic-v1.html's
 * `.rail` + downgrade/incomplete banners. This is a *summary*; the full
 * per-stage sections (artifact previews, file lists) render further down via
 * FindingDynamicCards — clicking a rail stage scrolls to its section.
 */
import { i18n } from "../../../shared/i18n";
import { Icon } from "../../../shared/components/Icon";
import {
  POC_STATE_DISPLAY,
  EXP_STATE_DISPLAY,
  resolvePocCardState,
  resolveExpCardState,
  showDowngradeBanner,
  type CardIcon,
} from "./finding-card-state";
import type { FindingMeta } from "../../../shared/api/client";

const STAGE_STYLE: React.CSSProperties = {
  textAlign: "left",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  background: "var(--bg-page)",
  padding: "9px 10px",
  minHeight: "64px",
  cursor: "pointer",
};

function StageBox({
  labelKey,
  color,
  icon,
  stateLabel,
  helper,
  dashed,
  onClick,
}: {
  labelKey: string;
  color: string;
  icon: CardIcon;
  stateLabel: string;
  helper: string;
  dashed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ ...STAGE_STYLE, ...(dashed ? { borderStyle: "dashed" } : {}) }}
    >
      <div style={{ fontSize: "10px", fontWeight: 800, color: "var(--text-secondary)", letterSpacing: "0.04em", marginBottom: "5px" }}>
        {i18n.t(labelKey)}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", fontWeight: 700, color, marginBottom: "3px" }}>
        <Icon name={icon} size={12} strokeWidth={2.5} />
        {stateLabel}
      </div>
      <div style={{ fontSize: "10.5px", lineHeight: 1.4, color: "var(--text-secondary)" }}>{helper}</div>
    </button>
  );
}

export function FindingStageRail({ finding, dynamicEnabled }: { finding: FindingMeta; dynamicEnabled: boolean }) {
  const pocStatus = finding.poc_status;
  const expStatus = finding.exp_status;
  const poc = resolvePocCardState({ dynamicEnabled, pocStatus });
  const exp = resolveExpCardState({ dynamicEnabled, pocStatus, expStatus });
  const pocDisplay = POC_STATE_DISPLAY[poc.status];
  const expDisplay = EXP_STATE_DISPLAY[exp.status];
  const isRisk = finding.item_type === "risk" || finding.finding_class === "risk";

  const scrollTo = (testid: string) => {
    document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const showIncompleteStrip = !isRisk && dynamicEnabled && (poc.derived === null && poc.status === "pending");
  const showDowngrade = !isRisk && showDowngradeBanner(expStatus);

  return (
    <div data-testid="finding-stage-rail" style={{ marginBottom: "12px" }}>
      {showIncompleteStrip ? (
        <div
          style={{
            display: "flex",
            gap: "8px",
            alignItems: "flex-start",
            background: "rgba(202,138,4,0.08)",
            border: "1px solid rgba(202,138,4,0.35)",
            color: "#92400e",
            borderRadius: "8px",
            padding: "9px 11px",
            fontSize: "11.5px",
            lineHeight: 1.55,
            marginBottom: "12px",
          }}
        >
          <Icon name="clock" size={13} strokeWidth={2.5} />
          <p style={{ margin: 0, flex: 1, minWidth: 0 }}>
            <b>{i18n.t("finding.cards.incomplete")}</b>
            {i18n.t("finding.cards.incompleteDetail")}
          </p>
        </div>
      ) : null}

      {showDowngrade ? (
        <div
          style={{
            display: "flex",
            gap: "9px",
            alignItems: "flex-start",
            background: "rgba(37,99,235,0.08)",
            border: "1px solid rgba(37,99,235,0.3)",
            color: "#1e40af",
            borderRadius: "8px",
            padding: "9px 11px",
            fontSize: "11.5px",
            lineHeight: 1.55,
            marginBottom: "12px",
          }}
        >
          <Icon name="trending-down" size={13} strokeWidth={2.5} />
          <p style={{ margin: 0, flex: 1, minWidth: 0 }}>{i18n.t("finding.cards.downgradeBanner")}</p>
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "8px" }}>
        <StageBox
          labelKey="finding.cards.static.title"
          color="#2563eb"
          icon="check-circle"
          stateLabel={i18n.t("finding.cards.static.confirmed")}
          helper={isRisk ? i18n.t("finding.cards.static.helperRisk") : i18n.t("finding.cards.static.helper")}
          onClick={() => scrollTo("finding-card-static")}
        />
        <StageBox
          labelKey="finding.cards.poc.title"
          color={isRisk ? "#737373" : poc.derived ? (poc.derived === "env_lost" ? "#dc2626" : "#737373") : pocDisplay.color}
          icon={isRisk ? "minus-circle" : poc.derived ? "clock" : pocDisplay.icon}
          stateLabel={isRisk ? i18n.t("finding.cards.poc.riskSkipLabel") : poc.derived ? i18n.t(`finding.cards.${poc.derived === "env_lost" ? "envLost" : "notEnabled"}`) : i18n.t(`finding.cards.status.${pocDisplay.labelKey}`)}
          helper={isRisk ? i18n.t("finding.cards.poc.riskSkipHelper") : poc.derived ? "" : i18n.t(`finding.cards.helper.${pocDisplay.helperKey}`)}
          dashed={isRisk || poc.derived === "not_enabled"}
          onClick={() => scrollTo("finding-card-poc")}
        />
        <StageBox
          labelKey="finding.cards.exp.title"
          color={isRisk ? "#737373" : exp.derived ? (exp.derived === "env_lost" ? "#dc2626" : "#737373") : expDisplay.color}
          icon={isRisk ? "minus-circle" : exp.derived ? "clock" : expDisplay.icon}
          stateLabel={isRisk ? i18n.t("finding.cards.exp.riskSkipLabel") : exp.derived ? i18n.t(`finding.cards.${exp.derived === "env_lost" ? "envLost" : "notEnabled"}`) : i18n.t(`finding.cards.status.${expDisplay.labelKey}`)}
          helper={isRisk ? i18n.t("finding.cards.exp.riskSkipHelper") : exp.derived ? "" : i18n.t(`finding.cards.helper.${expDisplay.helperKey}`)}
          dashed={isRisk || exp.derived === "not_enabled"}
          onClick={() => scrollTo("finding-card-exp")}
        />
      </div>
    </div>
  );
}
