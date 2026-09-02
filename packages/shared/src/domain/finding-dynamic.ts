export const FINDING_CLASSES = [
  "vulnerability",
  "risk",
  "unknown",
] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];

export const POC_STATUSES = [
  "pending",
  "reproduced",
  "fail-reproduced",
  "blocked",
  "not-needed",
  "unknown",
] as const;
export type PocStatus = (typeof POC_STATUSES)[number];

export const EXP_STATUSES = [
  "pending",
  // HALL-35: vulnerability finding created by verify, PoC not yet run —
  // the engine advances it to `pending` only after a successful reproduction.
  "awaiting-poc",
  "confirmed",
  "downgraded",
  "failed",
  "blocked",
  "not-needed",
  "unknown",
] as const;
export type ExpStatus = (typeof EXP_STATUSES)[number];

export interface FindingDynamicMeta {
  finding_class: FindingClass | null;
  poc_status: PocStatus | null;
  exp_status: ExpStatus | null;
  affected_versions: string | null;
}

export function isFindingClass(value: unknown): value is FindingClass {
  return typeof value === "string" && FINDING_CLASSES.includes(value as FindingClass);
}

export function isPocStatus(value: unknown): value is PocStatus {
  return typeof value === "string" && POC_STATUSES.includes(value as PocStatus);
}

export function isExpStatus(value: unknown): value is ExpStatus {
  return typeof value === "string" && EXP_STATUSES.includes(value as ExpStatus);
}
