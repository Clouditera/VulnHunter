-- 046: L4 deep verification status on credentials.
-- After save gate (L1-L3 pass), an async L4 check runs in the background.
-- This tracks its result so the settings UI can show a badge.

ALTER TABLE llm_credentials
  ADD COLUMN IF NOT EXISTS deep_verified_status TEXT;

ALTER TABLE llm_credentials
  ADD COLUMN IF NOT EXISTS deep_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN llm_credentials.deep_verified_status IS 'pending|running|passed|failed — async L4 agent circuit check';
COMMENT ON COLUMN llm_credentials.deep_verified_at IS 'When the L4 check completed';
