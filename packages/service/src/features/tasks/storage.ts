import { getDb } from "../../infra/db/client.js";
import type { TaskState } from "@vulnhunt/shared";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export interface DbTask {
  id: string;
  tenant_id: string;
  created_by: string;
  project_name: string;
  state: TaskState;
  source_type: string;
  source_meta: Record<string, string | number | boolean | null>;
  risk_score: number | null;
  failure_reason: string | null;
  total_tokens_in: number;
  total_tokens_out: number;
  tool_call_count: number;
  stage_count: number;
  auto_skill_ids: string[];
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  duration_ms: number | null;
  findings_indexed_at: Date | null;
  metadata: Record<string, unknown>;
  credential_id: string | null;
}

export async function createTask(params: {
  createdBy: string;
  projectName: string;
  sourceType: "upload" | "git";
  sourceMeta: Record<string, string | number | boolean | null>;
  autoSkillIds?: string[];
  credentialId?: string;
}): Promise<DbTask> {
  const db = getDb();
  const rows = await db<DbTask[]>`
    INSERT INTO tasks (tenant_id, created_by, project_name, source_type, source_meta, auto_skill_ids, credential_id)
    VALUES (${DEFAULT_TENANT_ID}, ${params.createdBy}, ${params.projectName},
            ${params.sourceType}, ${JSON.stringify(params.sourceMeta)}::jsonb,
            ${params.autoSkillIds ?? []}, ${params.credentialId ?? null})
    RETURNING *
  `;
  return rows[0];
}

export async function getTaskById(id: string): Promise<DbTask | null> {
  const db = getDb();
  const rows = await db<DbTask[]>`
    SELECT * FROM tasks
    WHERE id = ${id} AND tenant_id = ${DEFAULT_TENANT_ID}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listTasks(params: {
  state?: TaskState;
  limit?: number;
  offset?: number;
}): Promise<DbTask[]> {
  const db = getDb();
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  if (params.state) {
    return db<DbTask[]>`
      SELECT * FROM tasks
      WHERE tenant_id = ${DEFAULT_TENANT_ID} AND state = ${params.state}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return db<DbTask[]>`
    SELECT * FROM tasks
    WHERE tenant_id = ${DEFAULT_TENANT_ID}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

export async function updateTaskState(
  id: string,
  state: TaskState,
  extra?: {
    startedAt?: Date;
    completedAt?: Date;
    durationMs?: number;
    failureReason?: string;
  },
): Promise<void> {
  const db = getDb();

  if (state === "running" && extra?.startedAt) {
    await db`
      UPDATE tasks SET state = ${state}, started_at = ${extra.startedAt}
      WHERE id = ${id}
    `;
  } else if ((state === "completed" || state === "failed" || state === "cancelled") && extra?.completedAt) {
    await db`
      UPDATE tasks
      SET state = ${state},
          completed_at = ${extra.completedAt},
          duration_ms = ${extra.durationMs ?? null},
          failure_reason = ${extra.failureReason ?? null}
      WHERE id = ${id}
    `;
  } else {
    await db`UPDATE tasks SET state = ${state} WHERE id = ${id}`;
  }
}

/** Full reset for restart — clears timestamps, metadata, findings so scheduler treats it as fresh */
export async function resetTaskForRestart(id: string): Promise<void> {
  const db = getDb();
  await db`
    UPDATE tasks
    SET state = 'queued',
        started_at = NULL,
        completed_at = NULL,
        duration_ms = NULL,
        failure_reason = NULL,
        findings_indexed_at = NULL,
        metadata = '{}'
    WHERE id = ${id}
  `;
  await db`DELETE FROM findings_meta WHERE task_id = ${id}`;
}

export async function countTasksByState(state: TaskState): Promise<number> {
  const db = getDb();
  const rows = await db<{ count: string }[]>`
    SELECT COUNT(*) as count FROM tasks
    WHERE tenant_id = ${DEFAULT_TENANT_ID} AND state = ${state}
  `;
  return Number(rows[0].count);
}

export async function getQueuedTasks(limit: number): Promise<DbTask[]> {
  const db = getDb();
  return db<DbTask[]>`
    SELECT * FROM tasks
    WHERE tenant_id = ${DEFAULT_TENANT_ID} AND state = 'queued'
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
}

export async function deleteTask(id: string): Promise<boolean> {
  const db = getDb();
  const rows = await db`DELETE FROM tasks WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function getFindingsSeverityCounts(
  taskIds: string[],
): Promise<Map<string, Record<string, number>>> {
  const db = getDb();
  if (taskIds.length === 0) return new Map();

  const rows = await db<{ task_id: string; severity: string; count: number }[]>`
    SELECT task_id, severity, COUNT(*)::int as count
    FROM findings_meta
    WHERE task_id = ANY(${taskIds})
    GROUP BY task_id, severity
  `;

  const result = new Map<string, Record<string, number>>();
  for (const row of rows) {
    if (!result.has(row.task_id)) {
      result.set(row.task_id, { high: 0, medium: 0, low: 0, info: 0 });
    }
    const counts = result.get(row.task_id)!;
    counts[row.severity] = row.count;
  }
  return result;
}
