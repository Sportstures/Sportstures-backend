-- Migration 010: competition details for the learner Competitions screen, and following.
-- Safe to run more than once. Requires migrations 001 to 009.
--
-- Every new column is optional. When one is empty the API works it out from the fixtures:
-- province from the schools taking part (one province, or "National"), age group from the teams,
-- dates from the first and last match, and rounds from the most matches any team has.

ALTER TABLE competitions ADD COLUMN IF NOT EXISTS province VARCHAR(30);
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS age_group VARCHAR(10);
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS total_rounds SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'competitions_dates_check') THEN
    ALTER TABLE competitions ADD CONSTRAINT competitions_dates_check
      CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'competitions_total_rounds_check') THEN
    ALTER TABLE competitions ADD CONSTRAINT competitions_total_rounds_check
      CHECK (total_rounds IS NULL OR total_rounds BETWEEN 1 AND 500);
  END IF;
END $$;

-- Following a competition turns its alerts on.
CREATE TABLE IF NOT EXISTS competition_follows (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, competition_id)
);

CREATE INDEX IF NOT EXISTS idx_competition_follows_competition ON competition_follows(competition_id);
