UPDATE system_config
SET config = jsonb_set(
  config,
  '{source_archive_upload_max_mb}',
  to_jsonb(COALESCE((config->>'source_archive_upload_max_mb')::int, (config->>'upload_zip_max_mb')::int, 500)),
  true
)
WHERE id = 1 AND NOT (config ? 'source_archive_upload_max_mb');

UPDATE system_config
SET config = jsonb_set(
  config,
  '{upload_zip_max_mb}',
  to_jsonb(COALESCE((config->>'source_archive_upload_max_mb')::int, (config->>'upload_zip_max_mb')::int, 500)),
  true
)
WHERE id = 1;
