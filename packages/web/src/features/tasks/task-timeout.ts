/**
 * Unfinished-completion display helpers (task-a3d095ad + fish 2026-08-09).
 *
 * A scan may end as `state=completed` with:
 *   - completion_reason="timeout"    → time budget cut (engine wrote incomplete)
 *   - completion_reason="incomplete" → soft gate (missing/stale/invalid/unsafe
 *                                       completion.yaml; no longer failed)
 * Both share the yellow UI family + continue-scan affordance. Natural finish
 * keeps the green completed pill.
 */

export interface TimeoutAwareTask {
  state: string;
  completion_reason?: string | null;
}

/** True when the task completed because the time budget ran out. */
export function isTaskTimedOut(task: TimeoutAwareTask): boolean {
  return task.state === "completed" && task.completion_reason === "timeout";
}

/** True when soft gate marked the audit potentially incomplete (not failed). */
export function isTaskIncomplete(task: TimeoutAwareTask): boolean {
  return task.state === "completed" && task.completion_reason === "incomplete";
}

/** Yellow-family unfinished states that should offer continue-scan. */
export function isTaskUnfinished(task: TimeoutAwareTask): boolean {
  return isTaskTimedOut(task) || isTaskIncomplete(task);
}

/**
 * Effective state for badges/pills:
 *   completed+timeout    → virtual `timed_out`
 *   completed+incomplete → virtual `incomplete`
 * StatusPill styles both in the yellow warning family.
 */
export function effectiveTaskState(task: TimeoutAwareTask): string {
  if (isTaskTimedOut(task)) return "timed_out";
  if (isTaskIncomplete(task)) return "incomplete";
  return task.state;
}
