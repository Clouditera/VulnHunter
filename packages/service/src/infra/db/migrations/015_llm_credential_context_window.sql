ALTER TABLE llm_credentials
  ADD COLUMN IF NOT EXISTS context_window_tokens integer NOT NULL DEFAULT 128000;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'llm_credentials_context_window_tokens_check'
  ) THEN
    ALTER TABLE llm_credentials
      ADD CONSTRAINT llm_credentials_context_window_tokens_check
      CHECK (context_window_tokens >= 1000 AND context_window_tokens <= 10000000);
  END IF;
END $$;
