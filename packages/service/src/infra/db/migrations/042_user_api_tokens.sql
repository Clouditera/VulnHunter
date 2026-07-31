-- 042: long-lived API tokens for server-to-server integrations (OpenVuln).
-- Bearer "vht_<random>" tokens resolve to their owning user's SessionUser.
-- Token plaintext is returned once at issue time; only sha256(rawToken) hex is stored.
-- No expiry column by design — revocation (revoked_at) is the only invalidation path.

CREATE TABLE IF NOT EXISTS user_api_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,   -- sha256(rawToken) hex
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

-- Hot-path lookup: resolve a live token by hash. Partial index keeps only
-- non-revoked rows so the auth check stays O(1) as revoked tokens accumulate.
CREATE INDEX IF NOT EXISTS idx_user_api_tokens_hash
  ON user_api_tokens(token_hash)
  WHERE revoked_at IS NULL;
