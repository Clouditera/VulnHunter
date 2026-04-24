-- Migration 006: POC/EXP generation tables

-- POC generation jobs (one per "Generate" click)
CREATE TABLE IF NOT EXISTS poc_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'queued',
  -- queued | preparing | running | completed | failed | cancelled
  target_mode TEXT NOT NULL DEFAULT 'provided',
  -- provided | auto_deploy
  target_url TEXT,
  custom_instructions TEXT,
  browser_tool TEXT NOT NULL DEFAULT 'deveye',
  finding_keys TEXT[] NOT NULL DEFAULT '{}',
  container_id TEXT,
  failure_reason TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms BIGINT
);

CREATE INDEX IF NOT EXISTS idx_poc_jobs_task ON poc_jobs(task_id);

-- POC results (one per finding, latest-wins)
CREATE TABLE IF NOT EXISTS poc_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES poc_jobs(id) ON DELETE CASCADE,
  finding_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  -- pending | reproduced | partial | not_reproduced | error | skipped
  poc_script_minio_key TEXT,
  result_json_minio_key TEXT,
  run_log_minio_key TEXT,
  screenshots_prefix TEXT,
  target_url TEXT,
  exit_code INTEGER,
  summary TEXT,
  evidence JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, finding_key)
);

CREATE INDEX IF NOT EXISTS idx_poc_results_task ON poc_results(task_id);

-- POC manual runs (one per "Run again" click)
CREATE TABLE IF NOT EXISTS poc_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  finding_key TEXT NOT NULL,
  result_id UUID REFERENCES poc_results(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  -- queued | running | completed | failed | cancelled
  target_url TEXT,
  custom_instructions TEXT,
  container_id TEXT,
  exit_code INTEGER,
  run_log_minio_key TEXT,
  events_minio_key TEXT,
  failure_reason TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms BIGINT
);

CREATE INDEX IF NOT EXISTS idx_poc_runs_task ON poc_runs(task_id, finding_key);

-- POC settings (singleton per tenant)
CREATE TABLE IF NOT EXISTS poc_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  default_target_mode TEXT NOT NULL DEFAULT 'provided',
  default_browser_tool TEXT NOT NULL DEFAULT 'deveye',
  deveye_server_url TEXT,
  deveye_token TEXT,
  default_concurrency INTEGER NOT NULL DEFAULT 1,
  poc_timeout_s INTEGER NOT NULL DEFAULT 1800,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
