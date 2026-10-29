-- Migration 005: coach signup API, canonical school/sport names, and one team per coach.
-- Run after 001_auth_foundation.sql, 002_roles_and_signup_profile.sql,
-- 003_coach_signup.sql, 003_free_text_player_sport.sql, and
-- 004_teams_competitions_fixtures.sql.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS email_verification_codes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  resend_after TIMESTAMP NOT NULL,
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE coaches ADD COLUMN IF NOT EXISTS school_id INTEGER REFERENCES schools(id) ON DELETE SET NULL;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS team_name VARCHAR(100);
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS team_level VARCHAR(50);
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS coaching_role VARCHAR(50);
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS experience VARCHAR(50);

ALTER TABLE teams ADD COLUMN IF NOT EXISTS school_id INTEGER REFERENCES schools(id) ON DELETE SET NULL;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS sport_id INTEGER REFERENCES sports(id) ON DELETE SET NULL;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS level VARCHAR(50);

DO $$
DECLARE
  coach_fk_name TEXT;
  has_user_fk BOOLEAN;
BEGIN
  SELECT c.conname INTO coach_fk_name
    FROM pg_constraint c
    JOIN unnest(c.conkey) AS key_column(attnum) ON TRUE
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key_column.attnum
   WHERE c.conrelid = 'teams'::regclass
     AND c.contype = 'f'
     AND c.confrelid = 'coaches'::regclass
     AND a.attname = 'coach_id'
   LIMIT 1;

  IF coach_fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE teams DROP CONSTRAINT %I', coach_fk_name);
    UPDATE teams t
       SET coach_id = c.user_id
      FROM coaches c
     WHERE t.coach_id = c.id;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN unnest(c.conkey) AS key_column(attnum) ON TRUE
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key_column.attnum
     WHERE c.conrelid = 'teams'::regclass
       AND c.contype = 'f'
       AND c.confrelid = 'users'::regclass
       AND a.attname = 'coach_id'
  ) INTO has_user_fk;

  IF NOT has_user_fk THEN
    ALTER TABLE teams ADD CONSTRAINT teams_coach_id_fkey
      FOREIGN KEY (coach_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS idx_coaches_user_id_unique ON coaches (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_one_per_coach ON teams (coach_id) WHERE coach_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_schools_name_trimmed_lower ON schools (lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_name_trimmed_lower ON sports (lower(btrim(name)));
