import type { FindingReviewStatus } from "../../../shared/api/client.js";

export type ReviewPickAction = "noop" | "confirm";

export function resolveReviewPickAction(
  current: FindingReviewStatus,
  next: FindingReviewStatus,
): ReviewPickAction {
  return current === next ? "noop" : "confirm";
}
