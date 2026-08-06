/**
 * Finding three-card state logic — pure mapping per the SSOT
 * (design-spec-finding-three-card-ssot-v1.0.md §2/§3/§4), separated from the
 * component for testability. Status enums come from the shared domain
 * (finding-dynamic.ts) and match the SSOT exactly; `upgraded` does NOT exist.
 */
import type { IconName } from "../../../shared/components/Icon";
import type { PocStatus, ExpStatus } from "@vulnhunter/shared";

export type CardIcon = Extract<
  IconName,
  "check-circle" | "clock" | "alert-circle" | "shield-alert" | "trending-down" | "alert-triangle" | "minus-circle"
>;

export interface CardStateDisplay {
  /** i18n key suffix for the status label. */
  labelKey: string;
  color: string;
  icon: CardIcon;
  /** i18n key suffix for the helper line. */
  helperKey: string;
}

/** POC 6-state display map (SSOT §2). */
export const POC_STATE_DISPLAY: Record<PocStatus, CardStateDisplay> = {
  pending: { labelKey: "pending", color: "var(--sev-medium)", icon: "clock", helperKey: "pending" },
  reproduced: { labelKey: "reproduced", color: "var(--status-completed)", icon: "check-circle", helperKey: "reproduced" },
  "fail-reproduced": { labelKey: "failReproduced", color: "var(--sev-high)", icon: "alert-circle", helperKey: "failReproduced" },
  blocked: { labelKey: "blocked", color: "var(--sev-medium)", icon: "shield-alert", helperKey: "blocked" },
  "not-needed": { labelKey: "notNeeded", color: "#0891b2", icon: "check-circle", helperKey: "notNeeded" },
  unknown: { labelKey: "unknown", color: "#737373", icon: "minus-circle", helperKey: "unknown" },
};

/** EXP 6-state display map (SSOT §3). No `upgraded` — the engine has none. */
export const EXP_STATE_DISPLAY: Record<ExpStatus, CardStateDisplay> = {
  pending: { labelKey: "pendingExp", color: "var(--sev-medium)", icon: "clock", helperKey: "pending" },
  confirmed: { labelKey: "confirmed", color: "var(--danger)", icon: "shield-alert", helperKey: "confirmed" },
  downgraded: { labelKey: "downgraded", color: "var(--brand)", icon: "trending-down", helperKey: "downgraded" },
  failed: { labelKey: "failed", color: "var(--sev-high)", icon: "alert-circle", helperKey: "failed" },
  blocked: { labelKey: "blocked", color: "var(--sev-medium)", icon: "shield-alert", helperKey: "blocked" },
  "not-needed": { labelKey: "notNeededExp", color: "#0891b2", icon: "check-circle", helperKey: "notNeededExp" },
  unknown: { labelKey: "unknown", color: "#737373", icon: "minus-circle", helperKey: "unknown" },
};

/** Derived (display) states that overlay the enum (SSOT §2/§3 派生态). */
export type DerivedState = "not_enabled" | "env_lost" | "timed_out" | null;

/**
 * Resolve the POC card's effective display state (SSOT §4 priority):
 * not-enabled (task didn't open dynamic) > env-lost > timed-out (scan hit its
 * time budget with verification still pending, task-a3d095ad) > poc_status enum.
 */
export function resolvePocCardState(input: {
  dynamicEnabled: boolean;
  envLost?: boolean;
  pocStatus: PocStatus | null;
  timedOut?: boolean;
}): { derived: DerivedState; status: PocStatus } {
  if (!input.dynamicEnabled) return { derived: "not_enabled", status: "pending" };
  if (input.envLost) return { derived: "env_lost", status: input.pocStatus ?? "unknown" };
  if (input.timedOut && (input.pocStatus ?? "pending") === "pending") {
    return { derived: "timed_out", status: "pending" };
  }
  return { derived: null, status: input.pocStatus ?? "unknown" };
}

/**
 * Resolve the EXP card's effective display state (SSOT §4 priority):
 * not-enabled > env-lost > timed-out (exp still pending) > waiting-for-POC
 * (poc not reproduced & exp pending) > not-needed terminal > exp_status enum.
 */
export function resolveExpCardState(input: {
  dynamicEnabled: boolean;
  envLost?: boolean;
  pocStatus: PocStatus | null;
  expStatus: ExpStatus | null;
  timedOut?: boolean;
}): { derived: DerivedState; status: ExpStatus; waitingForPoc: boolean } {
  if (!input.dynamicEnabled) return { derived: "not_enabled", status: "pending", waitingForPoc: false };
  if (input.envLost) return { derived: "env_lost", status: input.expStatus ?? "unknown", waitingForPoc: false };
  const exp = input.expStatus ?? "unknown";
  const poc = input.pocStatus ?? "unknown";
  // not-needed is a terminal state and is never overridden by the POC wait.
  if (exp === "not-needed") return { derived: null, status: exp, waitingForPoc: false };
  if (input.timedOut && exp === "pending") {
    return { derived: "timed_out", status: "pending", waitingForPoc: false };
  }
  if (poc !== "reproduced" && exp === "pending") {
    return { derived: null, status: "pending", waitingForPoc: true };
  }
  return { derived: null, status: exp, waitingForPoc: false };
}

/** Whether the "漏洞信息尚未完全确定" banner shows on a dynamic card (SSOT §2/§3). */
export function showIncompleteBanner(dynamicEnabled: boolean, status: PocStatus | ExpStatus): boolean {
  return dynamicEnabled && status === "pending";
}

/** Whether the downgrade banner shows above the report (SSOT §3). */
export function showDowngradeBanner(expStatus: ExpStatus | null): boolean {
  return expStatus === "downgraded";
}
