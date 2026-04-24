-- Migration 007: Multi-user support
-- Add display_name, must_change_password, last_login_at to users table

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Backfill existing admin: display_name = email prefix
UPDATE users SET display_name = split_part(email, '@', 1) WHERE display_name = '';
