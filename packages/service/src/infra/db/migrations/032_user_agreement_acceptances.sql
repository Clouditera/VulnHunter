-- 032: registration agreement consent trail (PRD §2a)
CREATE TABLE IF NOT EXISTS user_agreement_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agreement_id TEXT NOT NULL,
  agreement_title TEXT NOT NULL,
  agreement_version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, agreement_id, agreement_version)
);

CREATE INDEX IF NOT EXISTS idx_user_agreement_acceptances_user
  ON user_agreement_acceptances (user_id, accepted_at DESC);
