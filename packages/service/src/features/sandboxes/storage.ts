/**
 * H2 task_sandboxes mapping (VulnHunter-owned; SandboxPlane stays opaque).
 * 1:1 per task (v1), deterministic request_id anchors the idempotent create.
 */

import { getDb } from "../../infra/db/client.js";

export type TaskSandboxState = "creating" | "ready" | "stopped" | "releasing" | "released" | "failed";

export interface TaskSandbox {
  task_id: string;
  sandbox_id: string;
  consumer: string;
  request_id: string;
  profile_id: string;
  arch: string | null;
  os: string | null;
  cpu_cores: number | null;
  memory_mb: number | null;
  ssh_host: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  /** Docker-internal IP for bastion ProxyJump (SandboxPlane v0.3.2). */
  ssh_internal_host: string | null;
  /** Instance host public key for StrictHostKeyChecking pin (#7). */
  ssh_host_public_key: string | null;
  host_key: string | null;
  /** Master-key-vault encrypted per-task SSH private key (051); null for
   *  pre-051 mappings or until the first allocate persists it. */
  ssh_key_ciphertext: Buffer | null;
  ssh_key_iv: Buffer | null;
  ssh_key_tag: Buffer | null;
  state: TaskSandboxState;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export const ACTIVE_SANDBOX_STATES: readonly TaskSandboxState[] = ["creating", "ready", "stopped", "releasing"];

export function sandboxRequestId(taskId: string): string {
  return `task-${taskId}-main`;
}

export async function getTaskSandbox(taskId: string): Promise<TaskSandbox | null> {
  const db = getDb();
  const rows = await db<TaskSandbox[]>`SELECT * FROM task_sandboxes WHERE task_id = ${taskId} LIMIT 1`;
  return rows[0] ?? null;
}

export async function upsertTaskSandbox(input: {
  task_id: string;
  sandbox_id: string;
  request_id: string;
  profile_id: string;
  arch?: string | null;
  os?: string | null;
  cpu_cores?: number | null;
  memory_mb?: number | null;
  ssh_host?: string | null;
  ssh_port?: number | null;
  ssh_user?: string | null;
  ssh_internal_host?: string | null;
  ssh_host_public_key?: string | null;
  state: TaskSandboxState;
  failure_reason?: string | null;
}): Promise<void> {
  const db = getDb();
  await db`
    INSERT INTO task_sandboxes (
      task_id, sandbox_id, request_id, profile_id, arch, os,
      cpu_cores, memory_mb, ssh_host, ssh_port, ssh_user,
      ssh_internal_host, ssh_host_public_key,
      state, failure_reason
    ) VALUES (
      ${input.task_id}, ${input.sandbox_id}, ${input.request_id}, ${input.profile_id},
      ${input.arch ?? null}, ${input.os ?? null},
      ${input.cpu_cores ?? null}, ${input.memory_mb ?? null},
      ${input.ssh_host ?? null}, ${input.ssh_port ?? null}, ${input.ssh_user ?? null},
      ${input.ssh_internal_host ?? null}, ${input.ssh_host_public_key ?? null},
      ${input.state}, ${input.failure_reason ?? null}
    )
    ON CONFLICT (task_id) DO UPDATE SET
      sandbox_id = EXCLUDED.sandbox_id,
      request_id = EXCLUDED.request_id,
      profile_id = EXCLUDED.profile_id,
      arch = EXCLUDED.arch,
      os = EXCLUDED.os,
      cpu_cores = EXCLUDED.cpu_cores,
      memory_mb = EXCLUDED.memory_mb,
      ssh_host = EXCLUDED.ssh_host,
      ssh_port = EXCLUDED.ssh_port,
      ssh_user = EXCLUDED.ssh_user,
      ssh_internal_host = EXCLUDED.ssh_internal_host,
      ssh_host_public_key = EXCLUDED.ssh_host_public_key,
      state = EXCLUDED.state,
      failure_reason = EXCLUDED.failure_reason,
      updated_at = now()
  `;
}

/** Persist the vault-encrypted private key onto the mapping row (051). */
export async function updateTaskSandboxSshKey(
  taskId: string,
  key: { ciphertext: Buffer; iv: Buffer; tag: Buffer },
): Promise<void> {
  const db = getDb();
  await db`
    UPDATE task_sandboxes
    SET ssh_key_ciphertext = ${key.ciphertext}, ssh_key_iv = ${key.iv}, ssh_key_tag = ${key.tag}, updated_at = now()
    WHERE task_id = ${taskId}
  `;
}

export async function updateTaskSandboxState(taskId: string, state: TaskSandboxState, failureReason: string | null = null): Promise<boolean> {
  const db = getDb();
  const rows = await db<{ task_id: string }[]>`
    UPDATE task_sandboxes SET state = ${state}, failure_reason = ${failureReason}, updated_at = now()
    WHERE task_id = ${taskId}
    RETURNING task_id
  `;
  return rows.length === 1;
}

export async function deleteTaskSandbox(taskId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db<{ task_id: string }[]>`
    DELETE FROM task_sandboxes WHERE task_id = ${taskId} RETURNING task_id
  `;
  return rows.length === 1;
}

/** Reconciler rule 1 input: mappings still expecting a live instance. */
export async function listActiveTaskSandboxes(limit = 200): Promise<TaskSandbox[]> {
  const db = getDb();
  return db<TaskSandbox[]>`
    SELECT * FROM task_sandboxes
    WHERE state = ANY(${["creating", "ready", "stopped", "releasing"]})
    ORDER BY created_at ASC LIMIT ${Math.max(1, limit)}
  `;
}

/** Reconciler rule 2 input: mapping row exists but the task row is gone. */
export async function listTaskSandboxesWithMissingTask(limit = 200): Promise<TaskSandbox[]> {
  const db = getDb();
  return db<TaskSandbox[]>`
    SELECT ts.* FROM task_sandboxes ts
    LEFT JOIN tasks t ON t.id = ts.task_id
    WHERE t.id IS NULL
    ORDER BY ts.created_at ASC LIMIT ${Math.max(1, limit)}
  `;
}

/** Reconciler rule 3 input: task terminal but instance not stopped/released. */
export async function listReadySandboxesOfTerminalTasks(limit = 200): Promise<TaskSandbox[]> {
  const db = getDb();
  return db<TaskSandbox[]>`
    SELECT ts.* FROM task_sandboxes ts
    JOIN tasks t ON t.id = ts.task_id
    WHERE ts.state = 'ready' AND t.state IN ('completed', 'failed', 'cancelled')
    ORDER BY ts.created_at ASC LIMIT ${Math.max(1, limit)}
  `;
}

/** H2 §3b quota gate input: the owner's running fleet + resource sum. */
export async function sumRunningSandboxesForUser(userId: string): Promise<{ running: number; cpu: number; memory_mb: number }> {
  const db = getDb();
  const rows = await db<{ running: string; cpu: string | null; memory_mb: string | null }[]>`
    SELECT COUNT(*) AS running,
           COALESCE(SUM(ts.cpu_cores), 0)::text AS cpu,
           COALESCE(SUM(ts.memory_mb), 0)::text AS memory_mb
    FROM task_sandboxes ts
    JOIN tasks t ON t.id = ts.task_id
    WHERE ts.state = 'ready' AND t.created_by = ${userId}
  `;
  const row = rows[0];
  return {
    running: Number(row?.running ?? 0),
    cpu: Number(row?.cpu ?? 0),
    memory_mb: Number(row?.memory_mb ?? 0),
  };
}

/** H2 §7: instance died mid-task → only still-pending dynamic states collapse to blocked. */
export async function blockPendingDynamicStates(taskId: string): Promise<{ poc: number; exp: number }> {
  const db = getDb();
  const poc = await db<{ finding_key: string }[]>`
    UPDATE findings_meta SET poc_status = 'blocked'
    WHERE task_id = ${taskId} AND poc_status = 'pending'
    RETURNING finding_key
  `;
  const exp = await db<{ finding_key: string }[]>`
    UPDATE findings_meta SET exp_status = 'blocked'
    WHERE task_id = ${taskId} AND exp_status = 'pending'
    RETURNING finding_key
  `;
  return { poc: poc.length, exp: exp.length };
}
