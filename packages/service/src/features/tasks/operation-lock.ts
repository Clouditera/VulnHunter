/**
 * Per-task operation lock — prevents concurrent scan/report operations.
 */

import { getDb } from "../../infra/db/client.js";

export interface ActiveOperation {
  type: "scan" | "report";
  id: string;
  state: string;
}

export async function getActiveTaskOperation(taskId: string): Promise<ActiveOperation | null> {
  const db = getDb();

  // Check scan active
  const [task] = await db<{ id: string; state: string }[]>`
    SELECT id, state FROM tasks WHERE id = ${taskId} AND state IN ('queued', 'preparing', 'running')
  `;
  if (task) return { type: "scan", id: task.id, state: task.state };

  // Check report active
  const [report] = await db<{ id: string; status: string }[]>`
    SELECT id, status FROM user_reports WHERE task_id = ${taskId} AND status = 'generating'
  `;
  if (report) return { type: "report", id: report.id, state: report.status };

  return null;
}

export async function assertNoActiveOperation(
  taskId: string,
  requested: "scan" | "report",
): Promise<void> {
  const active = await getActiveTaskOperation(taskId);
  if (!active) return;

  // Allow same-type check to pass for idempotent cases handled by callers
  // But block cross-type conflicts
  if (active.type !== requested || (active.type === requested && requested !== "scan")) {
    const err = new Error(`Task already has an active ${active.type} operation`) as Error & {
      code: string;
      active: ActiveOperation;
    };
    err.code = "ERR_TASK_BUSY";
    err.active = active;
    throw err;
  }
}
