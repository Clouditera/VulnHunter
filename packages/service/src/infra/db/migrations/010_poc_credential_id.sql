-- Migration 010: Add credential_id to poc_jobs for per-job credential selection
ALTER TABLE poc_jobs ADD COLUMN IF NOT EXISTS credential_id UUID;
