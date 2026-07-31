-- 043: API token self-service — optional expiry + list management.
-- expires_at NULL = permanent. Resolve path rejects expired tokens.

ALTER TABLE user_api_tokens
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Hot-path resolve already filters revoked; expired checked in query/app.
COMMENT ON COLUMN user_api_tokens.expires_at IS 'NULL = never expires; past now() = invalid';
