-- Migration 002: roles table, signup profile fields, schools, sports, learner profiles.
-- Safe to run more than once. Run in pgAdmin Query Tool on the sportstures database.
-- Requires migration 001.

-- 1. Roles ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(30) UNIQUE NOT NULL,
  description VARCHAR(255)
);

INSERT INTO roles (name, description) VALUES
  ('learner', 'Student who plays sport and follows matches'),
  ('coach', 'Coaches a team'),
  ('admin', 'Platform administrator')
ON CONFLICT (name) DO NOTHING;

-- 2. Move users from the old text column (users.role) to users.role_id --------
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'role'
  ) THEN
    UPDATE users
       SET role_id = (
         SELECT id FROM roles
          WHERE name = CASE users.role WHEN 'user' THEN 'learner' ELSE users.role END
       )
     WHERE role_id IS NULL;
    ALTER TABLE users DROP COLUMN role;
  END IF;
END $$;

ALTER TABLE users ALTER COLUMN role_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id);

-- 3. Personal details from signup step 1 -----------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(10);

-- 4. Schools and sports -------------------------------------------------------
CREATE TABLE IF NOT EXISTS schools (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- One school per name, ignoring upper/lower case ("Jeppe High" = "jeppe high")
CREATE UNIQUE INDEX IF NOT EXISTS idx_schools_name_lower ON schools (lower(name));

CREATE TABLE IF NOT EXISTS sports (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL
);

INSERT INTO sports (name) VALUES
  ('Athletics'), ('Basketball'), ('Cricket'), ('Football'), ('Hockey'),
  ('Netball'), ('Rugby'), ('Tennis'), ('Volleyball')
ON CONFLICT (name) DO NOTHING;

-- 5. Learner profile (signup steps 2 and 3) ------------------------------------
CREATE TABLE IF NOT EXISTS learner_profiles (
  user_id INTEGER PRIMARY KEY,
  school_id INTEGER,
  grade SMALLINT CHECK (grade BETWEEN 1 AND 12),
  class_name VARCHAR(50),
  sport_id INTEGER,
  team_name VARCHAR(100),
  jersey_number SMALLINT CHECK (jersey_number BETWEEN 0 AND 999),
  level VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL,
  FOREIGN KEY (sport_id) REFERENCES sports(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_learner_profiles_school_id ON learner_profiles(school_id);
CREATE INDEX IF NOT EXISTS idx_learner_profiles_sport_id ON learner_profiles(sport_id);
