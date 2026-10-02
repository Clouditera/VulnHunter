-- Migration 058: HALL-35 engine-scheduled dynamic verification.
-- verify now writes exp_status=awaiting-poc for new vulnerability findings;
-- poc-verify advances it to pending only after a successful reproduction.
-- Extend the existing exp_status CHECK constraint; nullable semantics
-- unchanged. CHECK constraints cannot be altered in place, so drop and
-- re-add idempotently (same pattern as 027).

ALTER TABLE findings_meta
  DROP CONSTRAINT IF EXISTS findings_meta_exp_status_check;

DO $$ BEGIN
  ALTER TABLE findings_meta
    ADD CONSTRAINT findings_meta_exp_status_check
    CHECK (exp_status IS NULL OR exp_status IN (
      'pending', 'awaiting-poc', 'confirmed', 'downgraded',
      'failed', 'blocked', 'not-needed', 'unknown'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
