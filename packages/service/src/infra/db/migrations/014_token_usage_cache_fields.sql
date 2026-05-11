ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS input_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tokens BIGINT NOT NULL DEFAULT 0;

UPDATE tasks
SET input_tokens = total_tokens_in,
    output_tokens = total_tokens_out,
    total_tokens = total_tokens_in + total_tokens_out
WHERE input_tokens = 0
  AND output_tokens = 0
  AND cache_read_tokens = 0
  AND cache_write_tokens = 0
  AND total_tokens = 0
  AND (total_tokens_in <> 0 OR total_tokens_out <> 0);
