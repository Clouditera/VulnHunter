-- 055: widen completion_reason to include 'incomplete' (fish 2026-08-09)
-- Soft audit-completion gate: missing/stale/invalid/unsafe completion.yaml
-- no longer fails the task; it completes with completion_reason=incomplete
-- (yellow UI + continue-scan), same family as timeout.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_completion_reason_check;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_completion_reason_check
  CHECK (completion_reason IN ('natural', 'timeout', 'incomplete'));
