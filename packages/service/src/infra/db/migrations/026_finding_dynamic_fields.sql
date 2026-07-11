-- Migration 026: VulnForge 2.0 Finding static/POC/EXP lifecycle metadata.
-- Additive and nullable by design: legacy rows must not gain inferred engine state.

ALTER TABLE findings_meta
  ADD COLUMN IF NOT EXISTS finding_class TEXT,
  ADD COLUMN IF NOT EXISTS poc_status TEXT,
  ADD COLUMN IF NOT EXISTS exp_status TEXT,
  ADD COLUMN IF NOT EXISTS affected_versions TEXT;

DO $$ BEGIN
  ALTER TABLE findings_meta
    ADD CONSTRAINT findings_meta_finding_class_check
    CHECK (finding_class IS NULL OR finding_class IN (
      'vulnerability', 'risk', 'unknown'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE findings_meta
    ADD CONSTRAINT findings_meta_poc_status_check
    CHECK (poc_status IS NULL OR poc_status IN (
      'pending', 'reproduced', 'fail-reproduced', 'blocked', 'unknown'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE findings_meta
    ADD CONSTRAINT findings_meta_exp_status_check
    CHECK (exp_status IS NULL OR exp_status IN (
      'pending', 'confirmed', 'downgraded', 'failed',
      'blocked', 'not-needed', 'unknown'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
