-- 045: API token prefix — non-secret digest for list display.
-- Stores first 12 chars of the token (e.g. "vht_a1b2c3d4") so users can
-- distinguish multiple tokens without exposing the full secret.
-- The full token plaintext is NEVER stored; only sha256 hash + this prefix.

ALTER TABLE user_api_tokens
  ADD COLUMN IF NOT EXISTS token_prefix TEXT;

COMMENT ON COLUMN user_api_tokens.token_prefix IS 'Non-secret prefix (first ~12 chars) for list display only';
