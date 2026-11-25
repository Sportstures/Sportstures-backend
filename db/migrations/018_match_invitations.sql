-- Migration 018: a coach invites another school's team to a match. It becomes a fixture only when
-- that team's coach accepts. Safe to run more than once. Requires migrations 001 to 017.
--
-- invited_team_id is the team that has to answer (the other team is the inviter's own team).
-- status: pending -> accepted (fixture_id is then set), declined or cancelled (by the inviter).
-- A pending invitation whose match_date has passed is shown as 'expired'; it is not stored.
CREATE TABLE IF NOT EXISTS match_invitations (
  id               SERIAL PRIMARY KEY,
  inviter_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  home_team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  away_team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  invited_team_id  INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  match_date       TIMESTAMPTZ NOT NULL,
  location         VARCHAR(255),
  competition_id   INTEGER REFERENCES competitions(id) ON DELETE SET NULL,
  match_type       VARCHAR(20) NOT NULL DEFAULT 'friendly'
                   CHECK (match_type IN ('league', 'semifinal', 'championship', 'friendly')),
  message          VARCHAR(500),
  status           VARCHAR(10) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  response_message VARCHAR(500),
  responded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  responded_at     TIMESTAMPTZ,
  fixture_id       INTEGER REFERENCES fixtures(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT match_invitations_different_teams CHECK (home_team_id <> away_team_id),
  CONSTRAINT match_invitations_invited_is_playing CHECK (invited_team_id IN (home_team_id, away_team_id))
);
CREATE INDEX IF NOT EXISTS idx_match_invitations_home ON match_invitations (home_team_id);
CREATE INDEX IF NOT EXISTS idx_match_invitations_away ON match_invitations (away_team_id);
-- The same two teams cannot have two open invitations for the same kick-off.
CREATE UNIQUE INDEX IF NOT EXISTS idx_match_invitations_one_open
  ON match_invitations (LEAST(home_team_id, away_team_id), GREATEST(home_team_id, away_team_id), match_date)
  WHERE status = 'pending';

-- Coaches get these in their notifications inbox; this is their on/off setting.
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS match_invitations BOOLEAN NOT NULL DEFAULT TRUE;
