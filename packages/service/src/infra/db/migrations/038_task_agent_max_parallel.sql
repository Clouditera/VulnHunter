-- Migration 038: per-task Agent max parallel (replaces system-level youngflow_max_parallel)

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS agent_max_parallel INTEGER NOT NULL DEFAULT 3;

-- In-flight tasks keep prior global behavior
UPDATE tasks
SET agent_max_parallel = COALESCE(
  (SELECT (config->>'youngflow_max_parallel')::int FROM system_config WHERE id = 1),
  3
)
WHERE state IN ('queued', 'preparing', 'running');
