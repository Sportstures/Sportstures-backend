-- Migration 003: coach signup fields from the mobile app.
-- Safe to run more than once. Requires migrations 001 and 002.

-- The coach signup lists Swimming, which the learner list did not have.
INSERT INTO sports (name) VALUES ('Swimming') ON CONFLICT (name) DO NOTHING;

-- Coaching step: school, team, level, coaching role, experience range.
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS school_id INTEGER REFERENCES schools(id) ON DELETE SET NULL;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS team_name VARCHAR(100);
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS team_level VARCHAR(50);
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS coaching_role VARCHAR(50);
-- The app offers ranges ("3 - 5 years"), so it is stored as text, not a number.
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS experience VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_coaches_school_id ON coaches(school_id);

-- Sports step: a coach can coach several sports.
CREATE TABLE IF NOT EXISTS coach_sports (
  coach_id INTEGER NOT NULL,
  sport_id INTEGER NOT NULL,
  PRIMARY KEY (coach_id, sport_id),
  FOREIGN KEY (coach_id) REFERENCES coaches(id) ON DELETE CASCADE,
  FOREIGN KEY (sport_id) REFERENCES sports(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_coach_sports_sport_id ON coach_sports(sport_id);
