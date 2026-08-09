-- 056: completion_reason natural|timeout only (fish 2026-08-09)
-- Platform no longer gates on completion.yaml; incomplete enum retired.
-- Defensive normalize if any row briefly held incomplete from 686621a.
UPDATE tasks SET completion_reason = 'natural' WHERE completion_reason = 'incomplete';
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_completion_reason_check;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_completion_reason_check
  CHECK (completion_reason IN ('natural', 'timeout'));
