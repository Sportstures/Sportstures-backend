-- Migration 020: learners' setting for live match notifications (kick-off, goals, goals ruled out).
-- Safe to run more than once. Requires migrations 001 to 019. Only adds a column, so the deployed
-- version keeps working until this runs.
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS live_matches BOOLEAN NOT NULL DEFAULT TRUE;
