-- 033: user feedback storage (chat list/search use existing tables + indexes)
CREATE TABLE IF NOT EXISTS user_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  satisfaction INT NOT NULL CHECK (satisfaction >= 1 AND satisfaction <= 10),
  content TEXT NOT NULL,
  contact_email TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_feedback_created
  ON user_feedback (tenant_id, created_at DESC);

-- Speed up chat title/content search (ILIKE / trigram optional; btree on updated_at already used)
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated
  ON chat_sessions (tenant_id, user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_seq
  ON chat_messages (session_id, seq);
