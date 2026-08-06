// Single source of truth moved to @vulnhunter/shared (task-8cb27359):
// the server enforces the same rule the UI does. This file stays as a
// re-export so existing web imports/tests keep working unchanged.
export {
  TASK_NAME_MAX_LENGTH,
  TASK_NAME_DISPLAY_LENGTH,
  getTaskNameError,
  normalizeTaskName,
  truncateTaskName,
} from "@vulnhunter/shared";
export type { TaskNameError } from "@vulnhunter/shared";
