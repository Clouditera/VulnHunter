-- Migration 011: Finding Review Workflow
-- Adds review_status to findings_meta + audit history table

ALTER TABLE findings_meta
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE findings_meta
    ADD CONSTRAINT findings_meta_review_status_check
    CHECK (review_status IN ('pending', 'confirmed', 'false_positive', 'ignored'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Migrate any existing user_verdict values
UPDATE findings_meta
SET review_status = CASE user_verdict
  WHEN 'confirmed' THEN 'confirmed'
  WHEN 'false_positive' THEN 'false_positive'
  WHEN 'wont_fix' THEN 'ignored'
  ELSE 'pending'
END
WHERE review_status = 'pending';

CREATE INDEX IF NOT EXISTS ix_findings_review_status
  ON findings_meta(task_id, review_status, severity_numeric DESC);

-- Audit history table
CREATE TABLE IF NOT EXISTS finding_review_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  finding_id UUID NOT NULL REFERENCES findings_meta(id) ON DELETE CASCADE,
  finding_key TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  old_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT finding_review_events_old_status_check
    CHECK (old_status IN ('pending', 'confirmed', 'false_positive', 'ignored')),
  CONSTRAINT finding_review_events_new_status_check
    CHECK (new_status IN ('pending', 'confirmed', 'false_positive', 'ignored'))
);

CREATE INDEX IF NOT EXISTS ix_finding_review_events_finding
  ON finding_review_events(task_id, finding_key, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_finding_review_events_user
  ON finding_review_events(user_id, created_at DESC);

-- Add finding_keys to reports for generation selection
ALTER TABLE user_reports
  ADD COLUMN IF NOT EXISTS finding_keys TEXT[] NOT NULL DEFAULT '{}';
