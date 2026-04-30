ALTER TABLE llm_credentials
  ADD COLUMN IF NOT EXISTS key_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS ix_llm_credentials_key_fingerprint
  ON llm_credentials(key_fingerprint);
