-- Migration 001: Initial schema
-- Creates core tables for VulnHunt v1.0

-- ── Tenants ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active', -- active | suspended
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- v1.0: single default tenant
INSERT INTO tenants (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'default')
ON CONFLICT DO NOTHING;

-- ── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member', -- admin | member
  status        TEXT NOT NULL DEFAULT 'active', -- active | suspended
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, email)
);

CREATE INDEX IF NOT EXISTS ix_users_tenant ON users(tenant_id);

-- ── Sessions ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_expires ON sessions(expires_at);

-- ── License ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS licenses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cert_raw          TEXT NOT NULL,          -- raw certificate string from vendor
  machine_code      TEXT NOT NULL,          -- installation_id at time of activation
  expires_at        TIMESTAMPTZ NOT NULL,
  activated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now() -- time-rollback defense
);

-- ── System Config ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_config (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  config     JSONB NOT NULL DEFAULT '{
    "max_parallel_scan": 3,
    "youngflow_max_parallel": 3,
    "max_parallel_chat": 5,
    "max_parallel_report": 3,
    "scan_cpu_limit": 2,
    "scan_memory_gb": 4,
    "chat_cpu_limit": 1,
    "chat_memory_gb": 2,
    "report_cpu_limit": 2,
    "report_memory_gb": 4,
    "upload_zip_max_mb": 500,
    "git_repo_max_mb": 1024,
    "live_log_buffer_cap": 1000,
    "chat_idle_timeout_min": 10,
    "worker_spawn_timeout_sec": 30
  }',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1) -- singleton
);

INSERT INTO system_config (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ── LLM Credentials ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS llm_credentials (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID REFERENCES tenants(id) ON DELETE CASCADE, -- NULL = global
  provider            TEXT NOT NULL,       -- anthropic | openai | minimax | ...
  proto_type          TEXT NOT NULL,       -- anthropic | openai (API protocol)
  base_url            TEXT,
  model_id            TEXT NOT NULL,
  thinking_effort     TEXT NOT NULL DEFAULT 'off', -- off | low | medium | high
  label               TEXT NOT NULL DEFAULT '',
  is_default          BOOLEAN NOT NULL DEFAULT false,
  -- encrypted API key
  api_key_ciphertext  BYTEA NOT NULL,
  api_key_iv          BYTEA NOT NULL,
  api_key_tag         BYTEA NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_llm_creds_tenant ON llm_credentials(tenant_id);
