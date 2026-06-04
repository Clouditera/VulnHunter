-- Migration 019: Multi-user data isolation support

ALTER TABLE users ADD COLUMN IF NOT EXISTS task_limit INTEGER NOT NULL DEFAULT 0;

ALTER TABLE llm_credentials ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ix_llm_creds_owner ON llm_credentials(owner_id);
