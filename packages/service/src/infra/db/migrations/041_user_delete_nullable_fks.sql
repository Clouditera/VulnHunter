-- Allow deleting users while keeping their historical tasks/reports (creator shown as deleted).
ALTER TABLE tasks ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE user_reports ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE report_skills ALTER COLUMN uploaded_by DROP NOT NULL;
ALTER TABLE poc_jobs ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE poc_runs ALTER COLUMN created_by DROP NOT NULL;

-- Review events: keep history, null out actor if user deleted
ALTER TABLE finding_review_events ALTER COLUMN user_id DROP NOT NULL;
