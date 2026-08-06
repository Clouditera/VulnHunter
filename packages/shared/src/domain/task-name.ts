/**
 * Shared task-name rule (single source of truth — frontend and backend).
 * Moved from packages/web/src/features/tasks/task-name.ts (DRUDGE-154
 * follow-up, task-8cb27359): the server enforces the same rule the UI does.
 */
export const TASK_NAME_MAX_LENGTH = 64;
export const TASK_NAME_DISPLAY_LENGTH = 32;

export type TaskNameError = "required" | "too_long" | "invalid_characters";

const TASK_NAME_PATTERN = /^[\p{Script=Han}A-Za-z0-9_\-()（）]+$/u;

export function normalizeTaskName(value: string): string {
  return value.trim();
}

export function getTaskNameError(value: string): TaskNameError | null {
  const normalized = normalizeTaskName(value);
  if (!normalized) return "required";
  if (Array.from(normalized).length > TASK_NAME_MAX_LENGTH) return "too_long";
  return TASK_NAME_PATTERN.test(normalized) ? null : "invalid_characters";
}

export function truncateTaskName(value: string): { text: string; truncated: boolean } {
  const characters = Array.from(value);
  if (characters.length <= TASK_NAME_DISPLAY_LENGTH) return { text: value, truncated: false };
  return { text: `${characters.slice(0, TASK_NAME_DISPLAY_LENGTH).join("")}…`, truncated: true };
}
