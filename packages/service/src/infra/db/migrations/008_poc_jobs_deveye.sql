-- Migration 008: Add per-job DeVeye config to poc_jobs
-- Allows overriding global poc_settings at generate time

ALTER TABLE poc_jobs ADD COLUMN IF NOT EXISTS deveye_server_url TEXT;
ALTER TABLE poc_jobs ADD COLUMN IF NOT EXISTS deveye_token TEXT;
