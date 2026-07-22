-- 031: email registration / password reset support
-- - users.source marks admin-created vs self-registered accounts
-- - email_verification_codes stores hashed one-time codes with TTL/attempts

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'admin';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_source_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_source_check CHECK (source IN ('admin', 'registered'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS email_verification_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'reset')),
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_codes_lookup
  ON email_verification_codes (tenant_id, email, purpose, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_codes_active
  ON email_verification_codes (tenant_id, email, purpose)
  WHERE consumed_at IS NULL;
