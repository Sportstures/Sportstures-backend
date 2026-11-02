-- Migration 007: team rosters.
-- Safe to run more than once. Requires migrations 001 to 006.
--
-- A learner joins a team in one of two ways:
--   * they ask to join ('pending'), and the team's coach approves them ('active'); or
--   * the coach adds them directly ('active').
-- A learner can be in several teams (for example football and athletics).

CREATE TABLE IF NOT EXISTS team_members (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  jersey_number SMALLINT CHECK (jersey_number IS NULL OR jersey_number BETWEEN 0 AND 999),
  position VARCHAR(50),
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (team_id, user_id)
);

-- Two active players on one team cannot wear the same number.
-- (Pending requests may ask for any number; it is checked when the coach approves.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_jersey_unique
  ON team_members (team_id, jersey_number)
  WHERE status = 'active' AND jersey_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team_status ON team_members(team_id, status);
