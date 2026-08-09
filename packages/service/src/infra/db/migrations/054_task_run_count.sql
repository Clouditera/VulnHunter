-- 054: task run_count (fish 2026-08-09 「共 N 段」)
-- Number of completed run segments (first run + continues). duration_ms = last
-- segment; total_duration_ms = sum; run_count = segment count.
-- Restart zeroes it; continue increments on each terminal completion.
-- Legacy rows stay 0 (= unknown → UI hides segment count, no fake data).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS run_count INT NOT NULL DEFAULT 0;
