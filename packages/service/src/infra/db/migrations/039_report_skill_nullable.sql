-- Migration 039: allow builtin default template (skill_id NULL) + safe skill delete
-- Drop/recreate FK so ON DELETE SET NULL; skill_id becomes nullable.

ALTER TABLE user_reports DROP CONSTRAINT IF EXISTS user_reports_skill_id_fkey;
ALTER TABLE user_reports ALTER COLUMN skill_id DROP NOT NULL;
ALTER TABLE user_reports ADD CONSTRAINT user_reports_skill_id_fkey
  FOREIGN KEY (skill_id) REFERENCES report_skills(id) ON DELETE SET NULL;
