-- Task metadata: profiler data + execution stats
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
