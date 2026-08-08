-- 052: task total_duration_ms (fish 2026-08-08 续跑时长累计)
-- Accumulated wall-clock across all run segments (first run + all resumes).
-- duration_ms stays as the LAST segment; total_duration_ms is the sum.
-- Restart (fresh reset) zeroes it; resume preserves and adds.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS total_duration_ms BIGINT DEFAULT 0;
