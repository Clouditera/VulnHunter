-- 022_ev_score_numeric.sql
-- ev_score was INTEGER but the engine emits decimal EV scores (e.g. 8.5),
-- causing "invalid input syntax for type integer" on index. Widen to NUMERIC
-- to match cvss_score. Idempotent via explicit type guard.

ALTER TABLE findings_meta ALTER COLUMN ev_score TYPE NUMERIC(3,1) USING ev_score::numeric;
