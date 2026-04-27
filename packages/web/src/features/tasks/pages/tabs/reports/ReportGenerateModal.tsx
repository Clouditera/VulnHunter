/**
 * Report generation modal with skill selection + finding selection.
 * Default: pending + confirmed findings selected; false_positive + ignored unchecked.
 */
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type FindingMeta, type FindingReviewStatus } from "../../../../../shared/api/client.js";
import { i18n } from "../../../../../shared/i18n/index.js";
import { ReviewStatusBadge } from "../../../components/FindingReviewControls.js";
import { Icon } from "../../../../../shared/components/Icon.js";

const SEV_COLORS: Record<string, string> = {
  high: "var(--sev-high)",
  medium: "var(--sev-medium)",
  low: "var(--sev-low)",
  info: "var(--sev-info)",
};

export interface ReportSkill {
  id: string;
  name: string;
  description?: string;
}

export function ReportGenerateModal({
  taskId,
  skills,
  onGenerate,
  onClose,
  pending,
}: {
  taskId: string;
  skills: ReportSkill[];
  onGenerate: (skillId: string, findingKeys: string[]) => void;
  onClose: () => void;
  pending: boolean;
}) {
  const [selectedSkillId, setSelectedSkillId] = useState<string>(skills[0]?.id ?? "");

  // Fetch all findings for this task
  const { data: findingsData } = useQuery({
    queryKey: ["findings", taskId, "all-for-report"],
    queryFn: () => api.findings.list(taskId, { limit: 1000 }),
  });
  const findings = findingsData?.findings ?? [];

  // Default: select pending + confirmed
  const [selectedKeys, setSelectedKeys] = useState<Set<string> | null>(null);

  const effectiveSelected = useMemo(() => {
    if (selectedKeys !== null) return selectedKeys;
    // Default selection
    return new Set(
      findings
        .filter((f) => !f.review_status || f.review_status === "pending" || f.review_status === "confirmed")
        .map((f) => f.finding_key),
    );
  }, [selectedKeys, findings]);

  function toggleKey(key: string) {
    const base = new Set(effectiveSelected);
    if (base.has(key)) base.delete(key); else base.add(key);
    setSelectedKeys(base);
  }

  function selectByStatus(statuses: FindingReviewStatus[]) {
    setSelectedKeys(new Set(
      findings.filter((f) => statuses.includes(f.review_status ?? "pending")).map((f) => f.finding_key),
    ));
  }

  const [showQuickMenu, setShowQuickMenu] = useState(false);

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ width: 560, maxHeight: "80vh", display: "flex", flexDirection: "column", borderRadius: 10, background: "var(--bg-card)", border: "1px solid var(--border)", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--divider)", fontSize: 14, fontWeight: 600 }}>
          {i18n.t("review.report.generate")}
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
          {/* Skill selection */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>报告模板</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {skills.map((sk) => (
                <button
                  key={sk.id}
                  onClick={() => setSelectedSkillId(sk.id)}
                  style={{
                    padding: "6px 14px", borderRadius: 6, fontSize: 12, fontFamily: "inherit", cursor: "pointer",
                    border: selectedSkillId === sk.id ? "1px solid var(--brand)" : "1px solid var(--border)",
                    background: selectedSkillId === sk.id ? "var(--bg-active-filter)" : "transparent",
                    color: selectedSkillId === sk.id ? "var(--brand)" : "var(--text-secondary)",
                    fontWeight: selectedSkillId === sk.id ? 600 : 400,
                  }}
                >
                  {sk.name}
                </button>
              ))}
            </div>
          </div>

          {/* Finding selection */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{i18n.t("review.report.includedFindings")}</span>
                <span style={{ fontSize: 12, color: "var(--text-secondary)", marginLeft: 6 }}>
                  ({effectiveSelected.size}/{findings.length})
                </span>
              </div>
              <div style={{ position: "relative" }}>
                <button
                  onClick={() => setShowQuickMenu(!showQuickMenu)}
                  style={{ padding: "3px 8px", border: "1px solid var(--border)", borderRadius: 4, background: "transparent", color: "var(--text-secondary)", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}
                >
                  按状态选择 ▾
                </button>
                {showQuickMenu && (
                  <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, zIndex: 10, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", minWidth: 160, overflow: "hidden" }}>
                    {[
                      { label: "待审核 + 已确认（推荐）", statuses: ["pending", "confirmed"] as FindingReviewStatus[] },
                      { label: "仅已确认", statuses: ["confirmed"] as FindingReviewStatus[] },
                      { label: "全部", statuses: ["pending", "confirmed", "false_positive", "ignored"] as FindingReviewStatus[] },
                    ].map((opt) => (
                      <div
                        key={opt.label}
                        onClick={() => { selectByStatus(opt.statuses); setShowQuickMenu(false); }}
                        style={{ padding: "6px 12px", cursor: "pointer", fontSize: 12 }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                      >
                        {opt.label}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Finding list */}
            <div style={{ maxHeight: 300, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
              {findings.map((f) => {
                const checked = effectiveSelected.has(f.finding_key);
                const suppressed = f.review_status === "false_positive" || f.review_status === "ignored";
                return (
                  <div
                    key={f.finding_key}
                    onClick={() => toggleKey(f.finding_key)}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", cursor: "pointer",
                      opacity: suppressed && !checked ? 0.5 : 1,
                      borderBottom: "1px solid var(--divider)",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <div style={{
                      width: 16, height: 16, borderRadius: 3, flexShrink: 0,
                      border: `1.5px solid ${checked ? "var(--brand)" : "var(--border)"}`,
                      background: checked ? "var(--brand)" : "transparent",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {checked && <span style={{ color: "#fff", fontSize: 10, fontWeight: 700 }}>✓</span>}
                    </div>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: SEV_COLORS[f.severity] ?? "#6b7280", flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {f.finding_key}
                    </span>
                    <span style={{ fontSize: 10, fontWeight: 600, color: SEV_COLORS[f.severity], textTransform: "uppercase", flexShrink: 0 }}>
                      {f.severity}
                    </span>
                    {f.review_status && f.review_status !== "pending" && (
                      <ReviewStatusBadge status={f.review_status} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--divider)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onClose}
            style={{ padding: "7px 16px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text-primary)", fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}
          >
            {i18n.t("review.action.cancel")}
          </button>
          <button
            onClick={() => onGenerate(selectedSkillId, Array.from(effectiveSelected))}
            disabled={effectiveSelected.size === 0 || !selectedSkillId || pending}
            style={{
              padding: "7px 16px", borderRadius: 6, border: "none", fontSize: 12, fontFamily: "inherit", fontWeight: 500,
              background: effectiveSelected.size > 0 && selectedSkillId ? "var(--brand)" : "var(--bg-disabled)",
              color: effectiveSelected.size > 0 && selectedSkillId ? "#fff" : "var(--text-secondary)",
              cursor: effectiveSelected.size > 0 && selectedSkillId && !pending ? "pointer" : "not-allowed",
              opacity: pending ? 0.6 : 1,
            }}
          >
            {i18n.t("review.report.generate")} ({effectiveSelected.size})
          </button>
        </div>
      </div>
    </div>
  );
}
