ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS display_name text;

CREATE INDEX IF NOT EXISTS ix_tasks_tenant_display_name
  ON tasks(tenant_id, display_name)
  WHERE display_name IS NOT NULL;
