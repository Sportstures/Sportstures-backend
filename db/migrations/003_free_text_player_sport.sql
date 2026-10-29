-- Migration 003: allow free-text player sport names
-- Run after 002_player_signup_verification.sql. Safe to run more than once.

ALTER TABLE player_profiles
  DROP CONSTRAINT IF EXISTS player_profiles_sport_name_check;

ALTER TABLE player_profiles
  ALTER COLUMN sport_name TYPE VARCHAR(100);
