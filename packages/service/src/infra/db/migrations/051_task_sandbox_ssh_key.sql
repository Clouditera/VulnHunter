-- 051: task sandbox SSH keypair persistence (fish-approved 2026-08-05)
-- Encrypted private key lives on the task↔sandbox mapping row (BYTEA triple,
-- master-key vault AES-GCM, same protection as llm_credentials). Mapping
-- delete (release/orphan sweep) kills the key with the row.
ALTER TABLE task_sandboxes
  ADD COLUMN IF NOT EXISTS ssh_key_ciphertext BYTEA,
  ADD COLUMN IF NOT EXISTS ssh_key_iv BYTEA,
  ADD COLUMN IF NOT EXISTS ssh_key_tag BYTEA;
