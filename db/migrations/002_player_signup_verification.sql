-- Migration 002: player signup profiles and email verification
-- Run after 001_auth_foundation.sql. Safe to run more than once.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'player', 'coach', 'admin'));

CREATE TABLE IF NOT EXISTS player_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  date_of_birth DATE NOT NULL,
  gender VARCHAR(10) NOT NULL CHECK (gender IN ('male', 'female')),
  school_name VARCHAR(255) NOT NULL,
  grade SMALLINT NOT NULL CHECK (grade BETWEEN 1 AND 12),
  class_name VARCHAR(100) NOT NULL,
  sport_name VARCHAR(20) CHECK (
    sport_name IS NULL OR sport_name IN (
      'Athletics', 'Basketball', 'Cricket', 'Football', 'Hockey',
      'Netball', 'Rugby', 'Tennis', 'Volleyball'
    )
  ),
  team_name VARCHAR(100),
  jersey_number SMALLINT CHECK (jersey_number IS NULL OR jersey_number BETWEEN 0 AND 999),
  sport_level VARCHAR(50),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS email_verification_codes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  resend_after TIMESTAMP NOT NULL,
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
