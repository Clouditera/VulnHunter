-- Migration 012: Chat Artifacts
-- Unified table for uploaded files and agent-presented artifacts in Chat

CREATE TABLE IF NOT EXISTS chat_artifacts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id     UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,  -- upload | presented | prepared_source
  title          TEXT,
  original_name  TEXT NOT NULL,
  filename       TEXT NOT NULL,
  mime_type      TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes     BIGINT NOT NULL DEFAULT 0,
  minio_key      TEXT NOT NULL,
  workspace_path TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE chat_artifacts
    ADD CONSTRAINT chat_artifacts_kind_check
    CHECK (kind IN ('upload', 'presented', 'prepared_source'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS ix_chat_artifacts_session_created
  ON chat_artifacts(session_id, created_at DESC);
