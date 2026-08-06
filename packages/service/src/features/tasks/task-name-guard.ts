/**
 * Server-side task-name guard (task-8cb27359, DRUDGE-154 follow-up).
 * Single rule lives in @vulnhunter/shared (task-name.ts); this is the
 * service-side throw wrapper. Create paths treat an ABSENT name as optional;
 * the rename endpoint requires a non-empty valid name.
 */
import { getTaskNameError } from "@vulnhunter/shared";
import { AppError } from "../../infra/app-error.js";

export function assertValidTaskName(
  name: string | undefined | null,
  opts?: { required?: boolean },
): void {
  if (name == null) {
    if (opts?.required) {
      throw new AppError("ERR_VALIDATION", { details: { field: "display_name" } });
    }
    return;
  }
  // getTaskNameError covers "" (required), >64 (too_long), bad charset.
  if (getTaskNameError(name)) {
    throw new AppError("ERR_VALIDATION", { details: { field: "display_name" } });
  }
}
