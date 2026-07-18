-- Stable per-install instance identity, used to scope worker container
-- ownership (label vulnagent.instance=<id>) so reconciler/event-subscription
-- on a shared Docker daemon only ever sees this install's own containers.
CREATE TABLE IF NOT EXISTS worker_instance (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  instance_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO worker_instance (id, instance_id)
VALUES (1, gen_random_uuid())
ON CONFLICT (id) DO NOTHING;
