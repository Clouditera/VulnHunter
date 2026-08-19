-- 057: credentials.max_output_tokens (fish 2026-08-19, maxTokens 不缺省化)
-- First-class output-limit knob mirroring context_window_tokens. Nullable:
-- NULL = fall through the buildModelsJson chain (pi catalog real value →
-- 128000 default). Existing credentials stay NULL (no behavior surprise).
ALTER TABLE llm_credentials ADD COLUMN IF NOT EXISTS max_output_tokens INTEGER DEFAULT NULL;
