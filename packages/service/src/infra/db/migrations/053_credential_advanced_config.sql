-- 053: credentials.advanced_config (fish 2026-08-08, unified credential module)
-- Stores vendor-specific model config overrides (compat / thinkingLevelMap /
-- input / cost) that are merged into models.json at generation time.
-- NULL = use defaults from pi catalog + scalar credential fields.
ALTER TABLE llm_credentials ADD COLUMN IF NOT EXISTS advanced_config JSONB DEFAULT NULL;
