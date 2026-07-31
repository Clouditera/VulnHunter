-- 044: system admin account (deploy-provisioned, cannot disable/delete)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

-- At most one system admin row is expected; index helps lookups.
CREATE INDEX IF NOT EXISTS idx_users_is_system ON users (is_system) WHERE is_system = true;
