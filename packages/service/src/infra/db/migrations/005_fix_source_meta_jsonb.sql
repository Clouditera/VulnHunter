-- Fix double-serialized source_meta: stored as JSONB string instead of JSONB object
-- Convert any string-typed JSONB values back to proper objects
UPDATE tasks
SET source_meta = source_meta::text::jsonb
WHERE jsonb_typeof(source_meta) = 'string';
