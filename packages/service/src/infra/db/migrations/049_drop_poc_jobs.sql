-- Retire the manual POC job chain (fish 2026-08-04): poc_jobs/poc_runs tables
-- and the eval-worker pipeline are removed. Runtime artifacts already landed
-- in MinIO; table data has no retention value. Scan-native dynamic
-- verification (findings_meta.poc_status/exp_status) is unaffected.
DROP TABLE IF EXISTS poc_runs;
DROP TABLE IF EXISTS poc_jobs;
