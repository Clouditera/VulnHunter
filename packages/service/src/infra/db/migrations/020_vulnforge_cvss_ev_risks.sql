-- Migration 020: VulnForge CVSS/EV scoring + risks support
-- Reuses findings_meta for both findings (BUG-*.yaml) and risks (RISK-*.yaml)
-- since their YAML schema is identical. item_type distinguishes them.

-- CVSS fields
ALTER TABLE findings_meta ADD COLUMN IF NOT EXISTS cvss_vector TEXT;
ALTER TABLE findings_meta ADD COLUMN IF NOT EXISTS cvss_score NUMERIC(3,1);

-- Exploit Value (EV) fields
ALTER TABLE findings_meta ADD COLUMN IF NOT EXISTS ev_vector TEXT;
ALTER TABLE findings_meta ADD COLUMN IF NOT EXISTS ev_score INTEGER;
ALTER TABLE findings_meta ADD COLUMN IF NOT EXISTS ev_priority TEXT;  -- P0-P4
ALTER TABLE findings_meta ADD COLUMN IF NOT EXISTS ev_rationale TEXT;

-- Finding vs Risk distinction
-- 'finding' = confirmed exploitable vulnerability (BUG-*.yaml)
-- 'risk'    = code risk worth tracking, hard to exploit (RISK-*.yaml)
ALTER TABLE findings_meta ADD COLUMN IF NOT EXISTS item_type TEXT NOT NULL DEFAULT 'finding';

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS ix_findings_item_type ON findings_meta(task_id, item_type);
CREATE INDEX IF NOT EXISTS ix_findings_ev_priority ON findings_meta(task_id, ev_priority);
