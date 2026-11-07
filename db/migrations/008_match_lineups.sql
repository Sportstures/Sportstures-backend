-- Match lineups: each team names its starters and bench for a fixture.
-- Jersey number and position are copied from the roster at submission time, so the match sheet
-- stays correct even if the roster changes later.

CREATE TABLE IF NOT EXISTS fixture_lineups (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  formation VARCHAR(30),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (fixture_id, team_id)
);

CREATE TABLE IF NOT EXISTS fixture_lineup_players (
  id SERIAL PRIMARY KEY,
  lineup_id INTEGER NOT NULL REFERENCES fixture_lineups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL CHECK (role IN ('starter', 'bench')),
  jersey_number SMALLINT,
  position VARCHAR(50),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  UNIQUE (lineup_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_lineup_players_user ON fixture_lineup_players(user_id);
