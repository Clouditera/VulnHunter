-- 050: task completion_reason — distinguish timeout-finalized scans (fish 2026-08-04)
-- 'natural' = ran to completion/failure; 'timeout' = engine finalized at the
-- user's scan-time limit (completion.yaml status=incomplete). Frontend maps
-- completed+timeout to the "已超时" badge.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS completion_reason TEXT NOT NULL DEFAULT 'natural';

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_completion_reason_check;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_completion_reason_check CHECK (completion_reason IN ('natural', 'timeout'));
