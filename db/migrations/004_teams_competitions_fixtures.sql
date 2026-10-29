-- Migration 004: teams with sport/school/level, competitions, richer fixtures.
-- Safe to run more than once. Requires migrations 001, 002 and 003.

-- 1. Competitions (leagues, cups, meets) -----------------------------------------
CREATE TABLE IF NOT EXISTS competitions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  sport_id INTEGER REFERENCES sports(id) ON DELETE SET NULL,
  season VARCHAR(20),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_competitions_name_lower ON competitions (lower(name));

-- 2. Teams: a team is one sport at one school, with a level and a category ------
ALTER TABLE teams ADD COLUMN IF NOT EXISTS school_id INTEGER REFERENCES schools(id) ON DELETE SET NULL;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS sport_id INTEGER REFERENCES sports(id) ON DELETE SET NULL;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS level VARCHAR(50);
ALTER TABLE teams ADD COLUMN IF NOT EXISTS gender_category VARCHAR(10);

CREATE INDEX IF NOT EXISTS idx_teams_school_id ON teams(school_id);
CREATE INDEX IF NOT EXISTS idx_teams_sport_id ON teams(sport_id);

-- 3. Fixtures ---------------------------------------------------------------------
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS competition_id INTEGER REFERENCES competitions(id) ON DELETE SET NULL;
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS match_type VARCHAR(20) NOT NULL DEFAULT 'league';
CREATE INDEX IF NOT EXISTS idx_fixtures_competition_id ON fixtures(competition_id);
CREATE INDEX IF NOT EXISTS idx_fixtures_match_date ON fixtures(match_date);

-- One score row per fixture (a team's score is then simply the fixture's score).
CREATE UNIQUE INDEX IF NOT EXISTS idx_scores_fixture_unique ON scores(fixture_id);

DO $$
BEGIN
  -- Match dates are real moments in time, so store them with a time zone.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fixtures' AND column_name = 'match_date'
      AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE fixtures
      ALTER COLUMN match_date TYPE TIMESTAMPTZ USING match_date AT TIME ZONE 'UTC';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fixtures_status_check') THEN
    ALTER TABLE fixtures ADD CONSTRAINT fixtures_status_check
      CHECK (status IN ('scheduled', 'live', 'finished', 'cancelled', 'postponed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fixtures_match_type_check') THEN
    ALTER TABLE fixtures ADD CONSTRAINT fixtures_match_type_check
      CHECK (match_type IN ('league', 'semifinal', 'championship', 'friendly'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fixtures_different_teams_check') THEN
    ALTER TABLE fixtures ADD CONSTRAINT fixtures_different_teams_check
      CHECK (home_team_id <> away_team_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_gender_category_check') THEN
    ALTER TABLE teams ADD CONSTRAINT teams_gender_category_check
      CHECK (gender_category IS NULL OR gender_category IN ('boys', 'girls', 'mixed'));
  END IF;
END $$;
