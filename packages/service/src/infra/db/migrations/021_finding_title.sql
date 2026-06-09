-- 021_finding_title.sql
-- Add engine-provided finding title (metadata.title) for human-readable list headings.
-- Idempotent: safe to re-run.

ALTER TABLE findings_meta ADD COLUMN IF NOT EXISTS title TEXT;
