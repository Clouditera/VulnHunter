-- 048: API token enable/disable lifecycle (fish 2026-08-04: rename/disable/delete ops)
-- status='active'|'disabled'; revoked_at stays as the legacy terminal state.
ALTER TABLE user_api_tokens
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE user_api_tokens
  DROP CONSTRAINT IF EXISTS user_api_tokens_status_check;
ALTER TABLE user_api_tokens
  ADD CONSTRAINT user_api_tokens_status_check CHECK (status IN ('active', 'disabled'));
