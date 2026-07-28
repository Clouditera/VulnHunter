-- Migration 037: report_skills owner (user-level skills; no platform-public exposure)
-- owner_user_id NULL = legacy/global rows kept but hidden from list/get APIs

ALTER TABLE report_skills
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_report_skills_owner ON report_skills (owner_user_id);
