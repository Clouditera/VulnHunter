/**
 * Task timeout display helpers (task-a3d095ad, fish 2026-08-04 / 2026-08-09).
 *
 * Platform writes completion_reason="timeout" when scan-mode drops
 * `.vulnhunter-timeout` under the task out dir. UI maps completed+timeout to
 * virtual 「已超时」. completion.yaml is NOT read by the platform.
 */

export interface TimeoutAwareTask {
  state: string;
  completion_reason?: string | null;
}

/** True when the task completed because the time budget ran out. */
export function isTaskTimedOut(task: TimeoutAwareTask): boolean {
  return task.state === "completed" && task.completion_reason === "timeout";
}

/** Effective state for badges/pills: completed+timeout → virtual `timed_out`. */
export function effectiveTaskState(task: TimeoutAwareTask): string {
  return isTaskTimedOut(task) ? "timed_out" : task.state;
}
