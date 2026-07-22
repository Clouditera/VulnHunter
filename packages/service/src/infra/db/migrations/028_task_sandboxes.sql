-- Migration 028: H2 sandbox instance lifecycle (docker-style: stop-not-destroy,
-- release only on task delete, no lease). task_sandboxes is the 1:1
-- task↔sandbox-instance mapping owned by VulnHunter; SandboxPlane stays
-- generic/opaque. Deterministic request_id makes create idempotent (no
-- double-open across owner crashes). No FK to tasks by design: the delete
-- flow and the reconciler own the release ordering, and a crashed delete must
-- not leave the mapping undeletable. User sandbox quota (H2 §3b) lives on
-- users: 0 = unlimited (task_limit convention).

CREATE TABLE IF NOT EXISTS task_sandboxes (
  task_id        UUID PRIMARY KEY,
  sandbox_id     TEXT NOT NULL,
  consumer       TEXT NOT NULL DEFAULT 'vulnhunter',
  request_id     TEXT NOT NULL,
  profile_id     TEXT NOT NULL,
  arch           TEXT,
  os             TEXT,
  cpu_cores      DOUBLE PRECISION,
  memory_mb      INTEGER,
  ssh_host       TEXT,
  ssh_port       INTEGER,
  ssh_user       TEXT,
  host_key       TEXT,
  state          TEXT NOT NULL DEFAULT 'creating',
  failure_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE task_sandboxes
    ADD CONSTRAINT task_sandboxes_state_check
    CHECK (state IN ('creating', 'ready', 'stopped', 'releasing', 'released', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS task_sandboxes_request_id_idx ON task_sandboxes (request_id);
CREATE INDEX IF NOT EXISTS task_sandboxes_state_idx ON task_sandboxes (state);

ALTER TABLE users ADD COLUMN IF NOT EXISTS sandbox_max_running INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sandbox_max_cpu_cores INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sandbox_max_memory_gb INTEGER NOT NULL DEFAULT 0;
