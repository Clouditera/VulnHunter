-- Migration 017: Add per-task YoungFlow/pi concurrency setting
UPDATE system_config
SET config = jsonb_set(config, '{youngflow_max_parallel}', COALESCE(config->'youngflow_max_parallel', '3'::jsonb), true),
    updated_at = now()
WHERE id = 1;
