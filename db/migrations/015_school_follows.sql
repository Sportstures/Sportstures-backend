-- Migration 015: schools a person follows. Every match of a followed school's teams shows in their feed
-- (GET /api/fixtures?favorites=true and GET /api/results?favorites=true), like a favourite team does.
-- Safe to run more than once. Requires migrations 001 to 014.
CREATE TABLE IF NOT EXISTS user_followed_schools (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, school_id)
);
CREATE INDEX IF NOT EXISTS idx_user_followed_schools_school ON user_followed_schools(school_id);
