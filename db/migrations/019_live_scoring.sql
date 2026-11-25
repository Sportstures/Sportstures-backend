-- Migration 019: live scoring. Coaches add goals during a live match; the other team's coach confirms
-- or disputes each one. Safe to run more than once. Requires migrations 001 to 018.
--
-- added_by_team_id is the side whose coach added the goal; the other side confirms it.
-- status: pending (not in the score yet) -> confirmed, or disputed (not counted). At full time every
-- goal still pending is confirmed (auto_confirmed = TRUE) and the final score is written to scores.
-- points: 1 for a goal; more for sports that score differently (a try, a three-pointer...).
CREATE TABLE IF NOT EXISTS fixture_goals (
  id               SERIAL PRIMARY KEY,
  fixture_id       INTEGER NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  minute           SMALLINT CHECK (minute IS NULL OR minute BETWEEN 0 AND 200),
  points           SMALLINT NOT NULL DEFAULT 1 CHECK (points BETWEEN 1 AND 10),
  status           VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'disputed')),
  auto_confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
  added_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_by_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  confirmed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at     TIMESTAMPTZ,
  dispute_reason   VARCHAR(500),
  disputed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  disputed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_fixture_goals_fixture ON fixture_goals (fixture_id, team_id, status);

ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

-- Coaches' setting for "a goal needs your confirmation" and "your goal was disputed".
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS goal_confirmations BOOLEAN NOT NULL DEFAULT TRUE;
