import { getDb } from "../../infra/db/client.js";
import type { TaskState } from "@vulnagent/shared";
import type { QueryContext } from "../../infra/query-context.js";
import { shouldFilterByUser } from "../../infra/query-context.js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export interface DbTask {
  id: string;
  tenant_id: string;
  created_by: string;
  project_name: string;
  display_name: string | null;
  state: TaskState;
  source_type: string;
  source_meta: Record<string, string | number | boolean | null>;
  risk_score: number | null;
  failure_reason: string | null;
  total_tokens_in: number;
  total_tokens_out: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
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

function tenantIdOf(ctx?: QueryContext): string {
  return ctx?.tenantId ?? DEFAULT_TENANT_ID;
}

function needsUserFilter(ctx?: QueryContext): ctx is QueryContext {
  return !!ctx && shouldFilterByUser(ctx);
}

function normalizeDisplayName(name?: string | null): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed.slice(0, 120) : null;
}

export async function createTask(params: {
  tenantId?: string;
  createdBy: string;
  projectName: string;
  displayName?: string | null;
  sourceType: "upload" | "git";
  sourceMeta: Record<string, string | number | boolean | null>;
  autoSkillIds?: string[];
  credentialId?: string;
}): Promise<DbTask> {
  const db = getDb();
  const rows = await db<DbTask[]>`
    INSERT INTO tasks (tenant_id, created_by, project_name, display_name, source_type, source_meta, auto_skill_ids, credential_id)
    VALUES (${params.tenantId ?? DEFAULT_TENANT_ID}, ${params.createdBy}, ${params.projectName}, ${normalizeDisplayName(params.displayName)},
            ${params.sourceType}, ${db.json(params.sourceMeta)}::jsonb,
            ${params.autoSkillIds ?? []}, ${params.credentialId ?? null})
    RETURNING *
  `;
  return rows[0];
}

export async function updateTaskDisplayName(ctx: QueryContext, id: string, displayName: string | null): Promise<DbTask | null>;
export async function updateTaskDisplayName(id: string, displayName: string | null): Promise<DbTask | null>;
export async function updateTaskDisplayName(a: QueryContext | string, b: string | null, c?: string | null): Promise<DbTask | null> {
  const db = getDb();
  const hasCtx = typeof a !== "string";
  const ctx = hasCtx ? a : undefined;
  const id = hasCtx ? b as string : a;
  const displayName = hasCtx ? c ?? null : b;
  const rows = needsUserFilter(ctx)
    ? await db<DbTask[]>`
      UPDATE tasks
      SET display_name = ${normalizeDisplayName(displayName)}
      WHERE id = ${id} AND tenant_id = ${ctx!.tenantId} AND created_by = ${ctx!.userId}
      RETURNING *
    `
    : await db<DbTask[]>`
      UPDATE tasks
      SET display_name = ${normalizeDisplayName(displayName)}
      WHERE id = ${id} AND tenant_id = ${tenantIdOf(ctx)}
      RETURNING *
    `;
  return rows[0] ?? null;
}

export async function getTaskById(ctx: QueryContext, id: string): Promise<DbTask | null>;
export async function getTaskById(id: string): Promise<DbTask | null>;
export async function getTaskById(a: QueryContext | string, b?: string): Promise<DbTask | null> {
  const db = getDb();
  const hasCtx = typeof a !== "string";
  const ctx = hasCtx ? a : undefined;
  const id = hasCtx ? b! : a;
  const rows = needsUserFilter(ctx)
    ? await db<DbTask[]>`
      SELECT * FROM tasks
      WHERE id = ${id} AND tenant_id = ${ctx!.tenantId} AND created_by = ${ctx!.userId}
      LIMIT 1
    `
    : await db<DbTask[]>`
      SELECT * FROM tasks
      WHERE id = ${id} AND tenant_id = ${tenantIdOf(ctx)}
      LIMIT 1
    `;
  return rows[0] ?? null;
}

export async function listTasks(
  ctx: QueryContext,
  params: { state?: TaskState; reviewStatus?: string; limit?: number; offset?: number; userId?: string },
): Promise<DbTask[]>;
export async function listTasks(params: { state?: TaskState; reviewStatus?: string; limit?: number; offset?: number }): Promise<DbTask[]>;
export async function listTasks(
  a: QueryContext | { state?: TaskState; reviewStatus?: string; limit?: number; offset?: number },
  b?: { state?: TaskState; reviewStatus?: string; limit?: number; offset?: number; userId?: string },
): Promise<DbTask[]> {
  const db = getDb();
  const hasCtx = "tenantId" in a;
  const ctx = hasCtx ? a as QueryContext : undefined;
  const params = (hasCtx ? b ?? {} : a) as { state?: TaskState; reviewStatus?: string; limit?: number; offset?: number; userId?: string };
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const tenantId = tenantIdOf(ctx);
  const filteredUserId = ctx && shouldFilterByUser(ctx) ? ctx.userId : (ctx?.role === "admin" ? params.userId : undefined);

  if (params.state && params.reviewStatus && filteredUserId) {
    return db<DbTask[]>`
      SELECT t.* FROM tasks t
      WHERE t.tenant_id = ${tenantId} AND t.created_by = ${filteredUserId} AND t.state = ${params.state}
        AND EXISTS (SELECT 1 FROM findings_meta f WHERE f.task_id = t.id AND f.review_status = ${params.reviewStatus})
      ORDER BY t.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }
  if (params.state && params.reviewStatus) {
    return db<DbTask[]>`
      SELECT t.* FROM tasks t
      WHERE t.tenant_id = ${tenantId} AND t.state = ${params.state}
        AND EXISTS (SELECT 1 FROM findings_meta f WHERE f.task_id = t.id AND f.review_status = ${params.reviewStatus})
      ORDER BY t.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }
  if (params.reviewStatus && filteredUserId) {
    return db<DbTask[]>`
      SELECT t.* FROM tasks t
      WHERE t.tenant_id = ${tenantId} AND t.created_by = ${filteredUserId}
        AND EXISTS (SELECT 1 FROM findings_meta f WHERE f.task_id = t.id AND f.review_status = ${params.reviewStatus})
      ORDER BY t.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }
  if (params.reviewStatus) {
    return db<DbTask[]>`
      SELECT t.* FROM tasks t
      WHERE t.tenant_id = ${tenantId}
        AND EXISTS (SELECT 1 FROM findings_meta f WHERE f.task_id = t.id AND f.review_status = ${params.reviewStatus})
      ORDER BY t.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }
  if (params.state && filteredUserId) {
    return db<DbTask[]>`
      SELECT * FROM tasks
      WHERE tenant_id = ${tenantId} AND created_by = ${filteredUserId} AND state = ${params.state}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }
  if (params.state) {
    return db<DbTask[]>`
      SELECT * FROM tasks
      WHERE tenant_id = ${tenantId} AND state = ${params.state}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }
  if (filteredUserId) {
    return db<DbTask[]>`
      SELECT * FROM tasks
      WHERE tenant_id = ${tenantId} AND created_by = ${filteredUserId}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }
  return db<DbTask[]>`
    SELECT * FROM tasks
    WHERE tenant_id = ${tenantId}
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

export async function queueTaskForResume(id: string): Promise<void> {
  const db = getDb();
  await db`
    UPDATE tasks
    SET state = 'queued',
        completed_at = NULL,
        failure_reason = NULL,
        duration_ms = NULL
    WHERE id = ${id}
  `;
}

export async function updateTaskCredential(id: string, credentialId: string | null): Promise<void> {
  const db = getDb();
  await db`UPDATE tasks SET credential_id = ${credentialId} WHERE id = ${id}`;
}

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

/**
 * Queue a completed/failed/cancelled task for a CONTINUE scan: keep all
 * historical findings + MinIO outputs, set `source_meta.continue_mode = true`
 * (and optionally override audit_focus / scan_timeout), and re-queue. Unlike
 * restart, findings_meta and scan-outputs are preserved; the scheduler will
 * download the historical outputs back into the worker workspace.
 */
export async function queueTaskForContinue(
  id: string,
  overrides?: { auditFocus?: string; scanTimeout?: number },
): Promise<void> {
  const db = getDb();
  const task = await getTaskById(id);
  const currentMeta: Record<string, unknown> =
    task && task.source_meta && typeof task.source_meta === "object"
      ? { ...(task.source_meta as Record<string, unknown>) }
      : {};
  currentMeta.continue_mode = true;
  if (overrides?.auditFocus !== undefined) currentMeta.audit_focus = overrides.auditFocus;
  if (overrides?.scanTimeout !== undefined) currentMeta.scan_timeout = overrides.scanTimeout;
  await db`
    UPDATE tasks
    SET state = 'queued',
        started_at = NULL,
        completed_at = NULL,
        duration_ms = NULL,
        failure_reason = NULL,
        source_meta = ${db.json(currentMeta as Record<string, string | number | boolean | null>)}::jsonb
    WHERE id = ${id}
  `;
}

/** Remove the continue_mode flag from a task's source_meta (post-completion). */
export async function clearContinueMode(id: string): Promise<void> {
  const db = getDb();
  await db`
    UPDATE tasks
    SET source_meta = (source_meta - 'continue_mode')
    WHERE id = ${id}
  `;
}

/** True when a task is queued/running in CONTINUE mode (source_meta flag). */
export function isContinueMode(task: DbTask): boolean {
  let meta: unknown = task.source_meta;
  if (typeof meta === "string") {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  return (meta as { continue_mode?: boolean } | null)?.continue_mode === true;
}

export async function countTasksByState(ctx: QueryContext, state: TaskState): Promise<number>;
export async function countTasksByState(state: TaskState): Promise<number>;
export async function countTasksByState(a: QueryContext | TaskState, b?: TaskState): Promise<number> {
  const db = getDb();
  const hasCtx = typeof a !== "string";
  const ctx = hasCtx ? a as QueryContext : undefined;
  const state = hasCtx ? b! : a as TaskState;
  const rows = needsUserFilter(ctx)
    ? await db<{ count: string }[]>`
      SELECT COUNT(*) as count FROM tasks
      WHERE tenant_id = ${ctx!.tenantId} AND created_by = ${ctx!.userId} AND state = ${state}
    `
    : await db<{ count: string }[]>`
      SELECT COUNT(*) as count FROM tasks
      WHERE tenant_id = ${tenantIdOf(ctx)} AND state = ${state}
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

/** All running task IDs across tenants (for scheduler incremental indexing). */
export async function getRunningTaskIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db<{ id: string }[]>`
    SELECT id FROM tasks WHERE state = 'running'
  `;
  return rows.map((r) => r.id);
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
    WHERE task_id = ANY(${taskIds}) AND item_type = 'finding'
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

export async function checkTaskLimit(ctx: QueryContext): Promise<{ allowed: boolean; used: number; limit: number }> {
  const db = getDb();
  const users = await db<{ task_limit: number }[]>`
    SELECT task_limit FROM users WHERE tenant_id = ${ctx.tenantId} AND id = ${ctx.userId}
  `;
  const limit = users[0]?.task_limit ?? 0;
  if (limit <= 0) return { allowed: true, used: 0, limit: 0 };
  const rows = await db<{ count: string }[]>`
    SELECT COUNT(*) as count FROM tasks
    WHERE tenant_id = ${ctx.tenantId} AND created_by = ${ctx.userId}
  `;
  const used = Number(rows[0]?.count ?? 0);
  return { allowed: used < limit, used, limit };
}

export async function countTasksForUser(ctx: QueryContext): Promise<number> {
  const db = getDb();
  const rows = await db<{ count: string }[]>`
    SELECT COUNT(*) as count FROM tasks
    WHERE tenant_id = ${ctx.tenantId} AND created_by = ${ctx.userId}
  `;
  return Number(rows[0]?.count ?? 0);
}
