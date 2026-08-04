/**
 * Task timeout display helpers (task-a3d095ad, fish 2026-08-04).
 *
 * A scan that exhausts its time budget is finalized by the engine as
 * `state=completed` with `completion_reason="timeout"` (backend判定落库在途).
 * The UI maps that combination to a dedicated 「已超时」 presentation so the
 * user can tell "time ran out" apart from "finished naturally" — and POC/EXP
 * surfaces explain that dynamic verification simply didn't get its turn.
 */

export interface TimeoutAwareTask {
  state: string;
  completion_reason?: string | null;
}

/** True when the task completed because the time budget ran out. */
export function isTaskTimedOut(task: TimeoutAwareTask): boolean {
  return task.state === "completed" && task.completion_reason === "timeout";
}

/**
 * Effective state for badges/pills: completed+timeout renders as the virtual
 * `timed_out` state (StatusPill has a dedicated style/label for it).
 */
export function effectiveTaskState(task: TimeoutAwareTask): string {
  return isTaskTimedOut(task) ? "timed_out" : task.state;
}
