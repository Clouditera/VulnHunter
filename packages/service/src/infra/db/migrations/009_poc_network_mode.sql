-- Migration 009: Add container network mode to poc_settings
ALTER TABLE poc_settings ADD COLUMN IF NOT EXISTS container_network_mode TEXT NOT NULL DEFAULT 'bridge';
-- 'bridge' (default, isolated) or 'host' (access host network, less secure)
