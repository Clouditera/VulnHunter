-- 036: admin credit codes inventory (CloudRouter redemption pool)
CREATE TABLE IF NOT EXISTS credit_codes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'available'
                   CHECK (status IN ('available', 'assigned')),
  assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_codes_status ON credit_codes (status);

-- One assigned code per user (available rows keep assigned_user_id NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_codes_one_per_user
  ON credit_codes (assigned_user_id) WHERE assigned_user_id IS NOT NULL;
