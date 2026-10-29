-- Initial database schema for Sportstures
-- This will be loaded automatically when the PostgreSQL container starts

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  phone VARCHAR(20),
  role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'player', 'coach', 'admin')),
  email_verified BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS player_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  date_of_birth DATE NOT NULL,
  gender VARCHAR(10) NOT NULL CHECK (gender IN ('male', 'female')),
  school_name VARCHAR(255) NOT NULL,
  grade SMALLINT NOT NULL CHECK (grade BETWEEN 1 AND 12),
  class_name VARCHAR(100) NOT NULL,
  sport_name VARCHAR(100),
  team_name VARCHAR(100),
  jersey_number SMALLINT CHECK (jersey_number IS NULL OR jersey_number BETWEEN 0 AND 999),
  sport_level VARCHAR(50),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS email_verification_codes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  resend_after TIMESTAMP NOT NULL,
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coaches (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL,
  specialization VARCHAR(100),
  years_of_experience INTEGER,
  certification VARCHAR(255),
  bio TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  coach_id INTEGER,
  description TEXT,
  founded_year INTEGER,
  location VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (coach_id) REFERENCES coaches(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS fixtures (
  id SERIAL PRIMARY KEY,
  home_team_id INTEGER NOT NULL,
  away_team_id INTEGER NOT NULL,
  match_date TIMESTAMP NOT NULL,
  location VARCHAR(255),
  status VARCHAR(50) DEFAULT 'scheduled',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (home_team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (away_team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scores (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  home_team_score INTEGER DEFAULT 0,
  away_team_score INTEGER DEFAULT 0,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (fixture_id) REFERENCES fixtures(id) ON DELETE CASCADE
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_coaches_user_id ON coaches(user_id);
CREATE INDEX IF NOT EXISTS idx_teams_coach_id ON teams(coach_id);
CREATE INDEX IF NOT EXISTS idx_fixtures_home_team_id ON fixtures(home_team_id);
CREATE INDEX IF NOT EXISTS idx_fixtures_away_team_id ON fixtures(away_team_id);
CREATE INDEX IF NOT EXISTS idx_scores_fixture_id ON scores(fixture_id);
