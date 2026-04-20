-- Migration 002: Tasks, Findings, Chat, Reports

-- ── Tasks ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by       UUID NOT NULL REFERENCES users(id),
  project_name     TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'queued',
  -- queued | running | paused | completed | failed | cancelled
  source_type      TEXT NOT NULL,       -- upload | git
  source_meta      JSONB NOT NULL DEFAULT '{}',
  -- { filename, git_url, git_branch, git_commit_sha }
  risk_score       NUMERIC(3,1),
  failure_reason   TEXT,
  total_tokens_in  BIGINT NOT NULL DEFAULT 0,
  total_tokens_out BIGINT NOT NULL DEFAULT 0,
  tool_call_count  INTEGER NOT NULL DEFAULT 0,
  stage_count      INTEGER NOT NULL DEFAULT 0,
  auto_skill_ids   TEXT[] NOT NULL DEFAULT '{}', -- skills to run after completion
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  duration_ms      BIGINT,
  findings_indexed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_tasks_tenant_state ON tasks(tenant_id, state);
CREATE INDEX IF NOT EXISTS ix_tasks_created ON tasks(tenant_id, created_at DESC);

-- ── Findings Meta ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS findings_meta (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  finding_key      TEXT NOT NULL,
  yaml_minio_key   TEXT NOT NULL,
  severity         TEXT NOT NULL,          -- high | medium | low | info
  severity_numeric SMALLINT NOT NULL,      -- 4/3/2/1 for ordering
  vuln_type        TEXT,
  vuln_type_full   TEXT,
  cwe              TEXT,
  primary_file     TEXT,
  primary_line     INTEGER,
  function_name    TEXT,
  language         TEXT,
  group_id         TEXT,
  attack_surface   TEXT,
  route_path       TEXT,
  analysis_round   SMALLINT,
  user_verdict     TEXT NOT NULL DEFAULT 'unverified',
  -- unverified | confirmed | false_positive | wont_fix | fixed
  user_notes       TEXT,
  indexed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  schema_version   SMALLINT NOT NULL DEFAULT 1,
  UNIQUE(task_id, finding_key)
);

CREATE INDEX IF NOT EXISTS ix_findings_task ON findings_meta(task_id, severity_numeric DESC);
CREATE INDEX IF NOT EXISTS ix_findings_tenant_sev ON findings_meta(tenant_id, severity_numeric);

-- ── Chat Sessions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                TEXT NOT NULL DEFAULT 'New Chat',
  worker_state         TEXT NOT NULL DEFAULT 'idle', -- idle | running
  worker_container_id  TEXT,
  session_minio_key    TEXT, -- chat-sessions/<id>/session.jsonl
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_chat_sessions_user ON chat_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL,
  user_id      UUID NOT NULL,
  role         TEXT NOT NULL,       -- user | assistant | tool_call | tool_result
  content      TEXT,
  tool_name    TEXT,
  tool_args    JSONB,
  tool_result  TEXT,
  seq          INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_chat_msgs_session ON chat_messages(session_id, seq);

-- ── Report Skills ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_skills (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID REFERENCES tenants(id) ON DELETE CASCADE, -- NULL = global
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  minio_key      TEXT NOT NULL,            -- report-skills/<id>.zip
  size_bytes     BIGINT NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  uploaded_by    UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── User Reports ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id           UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  skill_id          UUID NOT NULL REFERENCES report_skills(id),
  status            TEXT NOT NULL DEFAULT 'generating',
  -- generating | completed | failed
  format            TEXT,                  -- md | html | json | pdf | ...
  primary_minio_key TEXT,
  bundle_minio_key  TEXT,
  events_minio_key  TEXT,
  failure_reason    TEXT,
  created_by        UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  duration_ms       BIGINT
);

CREATE INDEX IF NOT EXISTS ix_user_reports_task ON user_reports(task_id, created_at DESC);
