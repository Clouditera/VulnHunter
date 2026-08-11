export type TaskState =
  | "queued"
  | "preparing"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface DisplayedScanDuration {
  total_duration_ms?: number | string | null;
  duration_ms?: number | string | null;
}

/**
 * Return the user-facing scan duration: accumulated completed segments when
 * available, otherwise the last segment retained by legacy task rows.
 */
export function displayedScanDurationMs(task: DisplayedScanDuration): number | null {
  const total = toDurationMs(task.total_duration_ms);
  return total != null && total > 0 ? total : toDurationMs(task.duration_ms);
}

function toDurationMs(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const duration = typeof value === "number" ? value : Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}
