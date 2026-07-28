-- Migration 040: user onboarding dismiss marker (CloudRouter promo onboarding)
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_dismissed_at TIMESTAMPTZ;
