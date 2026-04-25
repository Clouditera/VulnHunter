/**
 * POC/EXP generation CRUD.
 * Tables: poc_jobs, poc_results, poc_runs, poc_settings (migration 006).
 */

import { getDb } from "../../infra/db/client.js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

// ─── Types ───

export interface DbPocJob {
  id: string;
  tenant_id: string;
  task_id: string;
  state: string;
  target_mode: string;
  target_url: string | null;
  custom_instructions: string | null;
  browser_tool: string;
  finding_keys: string[];
  container_id: string | null;
  failure_reason: string | null;
  deveye_server_url: string | null;
  deveye_token: string | null;
  created_by: string;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  duration_ms: number | null;
}

export interface DbPocResult {
  id: string;
  tenant_id: string;
  task_id: string;
  job_id: string;
  finding_key: string;
  status: string;
  poc_script_minio_key: string | null;
  result_json_minio_key: string | null;
  run_log_minio_key: string | null;
  screenshots_prefix: string | null;
  target_url: string | null;
  exit_code: number | null;
  summary: string | null;
  evidence: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface DbPocRun {
  id: string;
  tenant_id: string;
  task_id: string;
  finding_key: string;
  result_id: string | null;
  state: string;
  target_url: string | null;
  custom_instructions: string | null;
  container_id: string | null;
  exit_code: number | null;
  run_log_minio_key: string | null;
  events_minio_key: string | null;
  failure_reason: string | null;
  created_by: string;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  duration_ms: number | null;
}

export interface DbPocSettings {
  tenant_id: string;
  default_target_mode: string;
  default_browser_tool: string;
  deveye_server_url: string | null;
  deveye_token: string | null;
  default_concurrency: number;
  poc_timeout_s: number;
  container_network_mode: string;
  updated_at: Date;
}

// ─── POC Jobs ───

export async function createPocJob(opts: {
  taskId: string;
  targetMode: string;
  targetUrl?: string;
  customInstructions?: string;
  browserTool?: string;
  findingKeys: string[];
  createdBy: string;
  deveyeServer?: string;
  deveyeToken?: string;
}): Promise<DbPocJob> {
  const db = getDb();
  const rows = await db<DbPocJob[]>`
    INSERT INTO poc_jobs (tenant_id, task_id, target_mode, target_url, custom_instructions, browser_tool, finding_keys, created_by, deveye_server_url, deveye_token)
    VALUES (
      ${DEFAULT_TENANT_ID},
      ${opts.taskId},
      ${opts.targetMode},
      ${opts.targetUrl ?? null},
      ${opts.customInstructions ?? null},
      ${opts.browserTool ?? "deveye"},
      ${opts.findingKeys},
      ${opts.createdBy},
      ${opts.deveyeServer ?? null},
      ${opts.deveyeToken ?? null}
    )
    RETURNING *
  `;
  return rows[0];
}

export async function getPocJob(id: string): Promise<DbPocJob | null> {
  const db = getDb();
  const rows = await db<DbPocJob[]>`SELECT * FROM poc_jobs WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function listPocJobs(taskId: string): Promise<DbPocJob[]> {
  const db = getDb();
  return db<DbPocJob[]>`
    SELECT * FROM poc_jobs
    WHERE task_id = ${taskId}
    ORDER BY created_at DESC
  `;
}

export async function updatePocJobState(
  id: string,
  state: string,
  opts?: {
    containerId?: string;
    startedAt?: Date;
    completedAt?: Date;
    durationMs?: number;
    failureReason?: string;
  },
): Promise<void> {
  const db = getDb();
  await db`
    UPDATE poc_jobs SET
      state = ${state},
      container_id = COALESCE(${opts?.containerId ?? null}, container_id),
      started_at = COALESCE(${opts?.startedAt ?? null}, started_at),
      completed_at = COALESCE(${opts?.completedAt ?? null}, completed_at),
      duration_ms = COALESCE(${opts?.durationMs ?? null}, duration_ms),
      failure_reason = COALESCE(${opts?.failureReason ?? null}, failure_reason)
    WHERE id = ${id}
  `;
}

export async function getQueuedPocJobs(limit: number): Promise<DbPocJob[]> {
  const db = getDb();
  return db<DbPocJob[]>`
    SELECT * FROM poc_jobs
    WHERE state = 'queued'
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
}

// ─── POC Results ───

export async function upsertPocResult(opts: {
  taskId: string;
  jobId: string;
  findingKey: string;
  status: string;
  pocScriptMinioKey?: string;
  resultJsonMinioKey?: string;
  runLogMinioKey?: string;
  screenshotsPrefix?: string;
  targetUrl?: string;
  exitCode?: number;
  summary?: string;
  evidence?: Record<string, unknown>;
}): Promise<DbPocResult> {
  const db = getDb();
  const rows = await db<DbPocResult[]>`
    INSERT INTO poc_results (
      tenant_id, task_id, job_id, finding_key, status,
      poc_script_minio_key, result_json_minio_key, run_log_minio_key,
      screenshots_prefix, target_url, exit_code, summary, evidence
    ) VALUES (
      ${DEFAULT_TENANT_ID},
      ${opts.taskId},
      ${opts.jobId},
      ${opts.findingKey},
      ${opts.status},
      ${opts.pocScriptMinioKey ?? null},
      ${opts.resultJsonMinioKey ?? null},
      ${opts.runLogMinioKey ?? null},
      ${opts.screenshotsPrefix ?? null},
      ${opts.targetUrl ?? null},
      ${opts.exitCode ?? null},
      ${opts.summary ?? null},
      ${opts.evidence ? JSON.stringify(opts.evidence) : null}
    )
    ON CONFLICT (task_id, finding_key) DO UPDATE SET
      job_id = EXCLUDED.job_id,
      status = EXCLUDED.status,
      poc_script_minio_key = COALESCE(EXCLUDED.poc_script_minio_key, poc_results.poc_script_minio_key),
      result_json_minio_key = COALESCE(EXCLUDED.result_json_minio_key, poc_results.result_json_minio_key),
      run_log_minio_key = COALESCE(EXCLUDED.run_log_minio_key, poc_results.run_log_minio_key),
      screenshots_prefix = COALESCE(EXCLUDED.screenshots_prefix, poc_results.screenshots_prefix),
      target_url = COALESCE(EXCLUDED.target_url, poc_results.target_url),
      exit_code = EXCLUDED.exit_code,
      summary = COALESCE(EXCLUDED.summary, poc_results.summary),
      evidence = COALESCE(EXCLUDED.evidence, poc_results.evidence),
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

export async function getPocResult(taskId: string, findingKey: string): Promise<DbPocResult | null> {
  const db = getDb();
  const rows = await db<DbPocResult[]>`
    SELECT * FROM poc_results
    WHERE task_id = ${taskId} AND finding_key = ${findingKey}
  `;
  return rows[0] ?? null;
}

export async function listPocResults(taskId: string): Promise<DbPocResult[]> {
  const db = getDb();
  return db<DbPocResult[]>`
    SELECT * FROM poc_results
    WHERE task_id = ${taskId}
    ORDER BY finding_key ASC
  `;
}

// ─── POC Runs ───

export async function createPocRun(opts: {
  taskId: string;
  findingKey: string;
  resultId?: string;
  targetUrl?: string;
  customInstructions?: string;
  createdBy: string;
}): Promise<DbPocRun> {
  const db = getDb();
  const rows = await db<DbPocRun[]>`
    INSERT INTO poc_runs (tenant_id, task_id, finding_key, result_id, target_url, custom_instructions, created_by)
    VALUES (
      ${DEFAULT_TENANT_ID},
      ${opts.taskId},
      ${opts.findingKey},
      ${opts.resultId ?? null},
      ${opts.targetUrl ?? null},
      ${opts.customInstructions ?? null},
      ${opts.createdBy}
    )
    RETURNING *
  `;
  return rows[0];
}

export async function getPocRun(id: string): Promise<DbPocRun | null> {
  const db = getDb();
  const rows = await db<DbPocRun[]>`SELECT * FROM poc_runs WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function listPocRuns(taskId: string, findingKey: string): Promise<DbPocRun[]> {
  const db = getDb();
  return db<DbPocRun[]>`
    SELECT * FROM poc_runs
    WHERE task_id = ${taskId} AND finding_key = ${findingKey}
    ORDER BY created_at DESC
  `;
}

export async function updatePocRunState(
  id: string,
  state: string,
  opts?: {
    containerId?: string;
    exitCode?: number;
    startedAt?: Date;
    completedAt?: Date;
    durationMs?: number;
    runLogMinioKey?: string;
    eventsMinioKey?: string;
    failureReason?: string;
  },
): Promise<void> {
  const db = getDb();
  await db`
    UPDATE poc_runs SET
      state = ${state},
      container_id = COALESCE(${opts?.containerId ?? null}, container_id),
      exit_code = COALESCE(${opts?.exitCode ?? null}, exit_code),
      started_at = COALESCE(${opts?.startedAt ?? null}, started_at),
      completed_at = COALESCE(${opts?.completedAt ?? null}, completed_at),
      duration_ms = COALESCE(${opts?.durationMs ?? null}, duration_ms),
      run_log_minio_key = COALESCE(${opts?.runLogMinioKey ?? null}, run_log_minio_key),
      events_minio_key = COALESCE(${opts?.eventsMinioKey ?? null}, events_minio_key),
      failure_reason = COALESCE(${opts?.failureReason ?? null}, failure_reason)
    WHERE id = ${id}
  `;
}

export async function getQueuedPocRuns(limit: number): Promise<DbPocRun[]> {
  const db = getDb();
  return db<DbPocRun[]>`
    SELECT * FROM poc_runs
    WHERE state = 'queued'
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
}

// ─── POC Settings ───

export async function getPocSettings(): Promise<DbPocSettings | null> {
  const db = getDb();
  const rows = await db<DbPocSettings[]>`
    SELECT * FROM poc_settings WHERE tenant_id = ${DEFAULT_TENANT_ID}
  `;
  return rows[0] ?? null;
}

export async function upsertPocSettings(opts: {
  defaultTargetMode?: string;
  defaultBrowserTool?: string;
  deveyeServerUrl?: string;
  deveyeToken?: string;
  defaultConcurrency?: number;
  pocTimeoutS?: number;
  containerNetworkMode?: string;
}): Promise<DbPocSettings> {
  const db = getDb();
  const rows = await db<DbPocSettings[]>`
    INSERT INTO poc_settings (tenant_id)
    VALUES (${DEFAULT_TENANT_ID})
    ON CONFLICT (tenant_id) DO UPDATE SET
      default_target_mode = COALESCE(${opts.defaultTargetMode ?? null}, poc_settings.default_target_mode),
      default_browser_tool = COALESCE(${opts.defaultBrowserTool ?? null}, poc_settings.default_browser_tool),
      deveye_server_url = COALESCE(${opts.deveyeServerUrl ?? null}, poc_settings.deveye_server_url),
      deveye_token = COALESCE(${opts.deveyeToken ?? null}, poc_settings.deveye_token),
      default_concurrency = COALESCE(${opts.defaultConcurrency ?? null}, poc_settings.default_concurrency),
      poc_timeout_s = COALESCE(${opts.pocTimeoutS ?? null}, poc_settings.poc_timeout_s),
      container_network_mode = COALESCE(${opts.containerNetworkMode ?? null}, poc_settings.container_network_mode),
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}
