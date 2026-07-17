-- Migration 027: VulnForge 1782ef6 engine emits poc_status=not-needed for
-- risk-class findings (no dynamic reproduction). Extend the existing CHECK
-- constraint; nullable semantics unchanged. CHECK constraints cannot be
-- altered in place, so drop and re-add idempotently.

ALTER TABLE findings_meta
  DROP CONSTRAINT IF EXISTS findings_meta_poc_status_check;

DO $$ BEGIN
  ALTER TABLE findings_meta
    ADD CONSTRAINT findings_meta_poc_status_check
    CHECK (poc_status IS NULL OR poc_status IN (
      'pending', 'reproduced', 'fail-reproduced', 'blocked',
      'not-needed', 'unknown'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
