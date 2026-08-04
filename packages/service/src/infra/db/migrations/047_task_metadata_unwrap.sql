-- 047: unwrap double-encoded tasks.metadata (JSONB string → JSONB object)
--
-- Root cause: 4abe6c81 (2026-04-22) wrote metadata via
--   UPDATE tasks SET metadata = ${JSON.stringify(m)}   -- no ::jsonb cast
-- so postgres.js stored a JSONB *string* containing JSON text. d59e53e4 fixed
-- the write path (and repaired source_meta via 005) but never repaired existing
-- metadata rows. SQL operators used by the scheduler (?, #>>, -, ||) fail on
-- scalar JSONB strings, which wedged tasks in `queued` after 2.2.x→2.3.x
-- upgrades (prod 2026-08-01: 62 rows unwrapped by hand).
--
-- Rows whose string payload fails to parse (or parses to a non-object) are left
-- untouched: the JS read path (parsedObject) already tolerates string form, and
-- a warning is emitted for manual follow-up.
DO $$
DECLARE
  r RECORD;
  unwrapped jsonb;
BEGIN
  FOR r IN
    SELECT id, metadata #>> '{}' AS txt
    FROM tasks
    WHERE jsonb_typeof(metadata) = 'string'
  LOOP
    BEGIN
      unwrapped := r.txt::jsonb;
      IF jsonb_typeof(unwrapped) = 'object' THEN
        UPDATE tasks SET metadata = unwrapped WHERE id = r.id;
      ELSE
        RAISE WARNING 'migration 047: tasks.metadata id % unwraps to %, left as-is', r.id, jsonb_typeof(unwrapped);
      END IF;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'migration 047: could not unwrap tasks.metadata for id %', r.id;
    END;
  END LOOP;
END $$;
