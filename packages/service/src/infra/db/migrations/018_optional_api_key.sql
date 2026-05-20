-- Migration 018: Allow model credentials without API keys for no-auth self-hosted endpoints
ALTER TABLE llm_credentials
  ALTER COLUMN api_key_ciphertext DROP NOT NULL,
  ALTER COLUMN api_key_iv DROP NOT NULL,
  ALTER COLUMN api_key_tag DROP NOT NULL;
