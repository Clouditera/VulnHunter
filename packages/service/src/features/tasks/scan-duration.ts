/**
 * H3 scan-duration two-tier semantics.
 *
 * Option one (custom): user-chosen active-stop deadline, default 10h, allowed
 * range 30min–72h. Option two (auto / free-schedule): a fixed 72h safety
 * ceiling with no platform time pressure before it — the engine decides its own
 * pacing and normally finishes far earlier. Both tiers drive the exact same
 * worker mechanism (SCAN_TIMEOUT → deadline runner → bounded finalizer).
 *
 * `scan_timeout` (seconds, in source_meta) remains the single deadline value;
 * `timeout_mode` ("custom" | "auto") is stored alongside it for UI/report
 * labeling. Legacy clients that pass scan_timeout without a mode are treated
 * as "custom" (backward compatible).
 */

export const SCAN_TIMEOUT_MODE_CUSTOM = "custom";
export const SCAN_TIMEOUT_MODE_AUTO = "auto";
export type ScanTimeoutMode = typeof SCAN_TIMEOUT_MODE_CUSTOM | typeof SCAN_TIMEOUT_MODE_AUTO;

/** Default for the custom tier: 10 hours. */
export const SCAN_TIMEOUT_DEFAULT_CUSTOM_S = 10 * 3600;
/** Lower bound for the custom tier: 30 minutes. */
export const SCAN_TIMEOUT_MIN_S = 1800;
/** fish 2026-08-13: no upper bound on custom scan duration. */
export const SCAN_TIMEOUT_MAX_S = Number.MAX_SAFE_INTEGER;
/** The auto tier always uses the fixed 72h safety ceiling. */
export const SCAN_TIMEOUT_AUTO_S = 72 * 3600;

export interface ResolvedScanDuration {
  scan_timeout: number;
  timeout_mode: ScanTimeoutMode;
}

function toPositiveInt(value: string | number | null | undefined): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.trunc(n);
}

/**
 * Normalize a (timeout_mode, scan_timeout) pair per H3.
 *
 * - mode "auto": ignore any user scan_timeout and force the fixed 72h ceiling.
 * - mode "custom" (or absent → legacy): validate scan_timeout against
 *   [MIN, MAX]; an absent value falls back to the 10h default; an out-of-range
 *   or invalid value is rejected (throws) so the caller can surface a 400
 *   rather than silently clamping a user intent.
 */
export function resolveScanDuration(
  mode: string | null | undefined,
  scanTimeout: string | number | null | undefined,
): ResolvedScanDuration {
  if (mode === SCAN_TIMEOUT_MODE_AUTO) {
    return { scan_timeout: SCAN_TIMEOUT_AUTO_S, timeout_mode: SCAN_TIMEOUT_MODE_AUTO };
  }
  // custom or absent (legacy clients) → custom tier.
  const raw = toPositiveInt(scanTimeout);
  if (raw === undefined) {
    return { scan_timeout: SCAN_TIMEOUT_DEFAULT_CUSTOM_S, timeout_mode: SCAN_TIMEOUT_MODE_CUSTOM };
  }
  if (raw < SCAN_TIMEOUT_MIN_S) {
    throw new Error(
      `scan_timeout must be at least ${SCAN_TIMEOUT_MIN_S}s (30min); got ${raw}s`,
    );
  }
  return { scan_timeout: raw, timeout_mode: SCAN_TIMEOUT_MODE_CUSTOM };
}

/**
 * Compute the platform-accounted scan deadline (ISO) for a run starting now.
 * Recorded in task metadata for observability and as the scheduler's fallback
 * clock; the worker's own deadline runner remains the normal executor.
 */
export function computeScanDeadlineAt(scanTimeoutSeconds: number, from: Date = new Date()): string {
  return new Date(from.getTime() + scanTimeoutSeconds * 1000).toISOString();
}

/**
 * Stuck-task fallback margin (H3 §3, form A). After deadline_at the worker may
 * still be running its own bounded finalizer (flow.timeout-finalize self-cap
 * 660s); the platform must not intervene before that window closes or it would
 * kill a report being written. The fallback therefore only fires when the task
 * is past deadline_at + FALLBACK_MARGIN_S with no terminal state. 720 = 660 +
 * 60s scheduling slack. If the finalize flow's own timeout changes, re-derive
 * this value.
 */
export const SCAN_FALLBACK_MARGIN_S = 720;

/**
 * Whether a task whose metadata deadline_at is `deadlineAtIso` is considered
 * "stuck" (past deadline + fallback margin) at `now`. Returns false when there
 * is no parseable deadline (no platform clock was recorded for this run).
 */
export function isScanDeadlineStuck(deadlineAtIso: unknown, now: Date = new Date()): boolean {
  if (typeof deadlineAtIso !== "string" || !deadlineAtIso) return false;
  const ms = Date.parse(deadlineAtIso);
  if (!Number.isFinite(ms)) return false;
  return now.getTime() > ms + SCAN_FALLBACK_MARGIN_S * 1000;
}
