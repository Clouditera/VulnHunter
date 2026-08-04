-- Retire the manual POC job chain (fish 2026-08-04): all four chain tables
-- removed in FK-safe order. qa-nery 2026-08-04: dropping only two crashed
-- upgrades on databases with POC history (2BP01, poc_results FK → poc_jobs).
-- architect scope: poc_settings holds deveye config remnants — also retired.
-- Runtime artifacts already landed in MinIO; table data has no retention
-- value. Scan-native dynamic verification (findings_meta
-- poc_status/exp_status) is unaffected.
DROP TABLE IF EXISTS poc_runs;
DROP TABLE IF EXISTS poc_results;
DROP TABLE IF EXISTS poc_jobs;
DROP TABLE IF EXISTS poc_settings;
