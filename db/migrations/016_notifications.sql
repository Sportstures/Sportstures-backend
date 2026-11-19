-- Migration 016: the in-app notifications inbox and each person's notification settings.
-- Safe to run more than once. Requires migrations 001 to 015.

-- One row per notification per person. data holds ids for the app to open the right screen
-- (fixtureId, teamId, competitionId). read_at is NULL while unread.
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(40) NOT NULL,
  title VARCHAR(200) NOT NULL,
  body VARCHAR(500),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;

-- A missing row means everything is on.
CREATE TABLE IF NOT EXISTS notification_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  match_results BOOLEAN NOT NULL DEFAULT TRUE,
  fixture_changes BOOLEAN NOT NULL DEFAULT TRUE,
  team_membership BOOLEAN NOT NULL DEFAULT TRUE,
  lineup_selection BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
