-- Migration 011: favourite sports and teams, and the sports catalogue the Favourite Sports screen shows.
-- Safe to run more than once. Requires migrations 001 to 010.

-- 1. Sports catalogue -------------------------------------------------------------------------
-- `key` is the id the mobile app saves (e.g. "waterPolo"); `category` groups the screen's tiles.
-- Sports added later by signups (free text) have no key or category and are listed under "Other".
ALTER TABLE sports ADD COLUMN IF NOT EXISTS key VARCHAR(40);
ALTER TABLE sports ADD COLUMN IF NOT EXISTS category VARCHAR(20);
ALTER TABLE sports ADD COLUMN IF NOT EXISTS sort_order SMALLINT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_key ON sports (key) WHERE key IS NOT NULL;

DROP TABLE IF EXISTS sport_catalogue;
CREATE TEMP TABLE sport_catalogue (name TEXT, key TEXT, category TEXT, sort_order SMALLINT);
INSERT INTO sport_catalogue VALUES
  ('Football', 'football', 'team', 1), ('Rugby', 'rugby', 'team', 2), ('Netball', 'netball', 'team', 3),
  ('Cricket', 'cricket', 'team', 4), ('Hockey', 'hockey', 'team', 5), ('Basketball', 'basketball', 'team', 6),
  ('Volleyball', 'volleyball', 'team', 7), ('Water Polo', 'waterPolo', 'team', 8), ('Softball', 'softball', 'team', 9),
  ('Baseball', 'baseball', 'team', 10), ('Handball', 'handball', 'team', 11), ('Touch Rugby', 'touchRugby', 'team', 12),
  ('Athletics', 'athletics', 'athletics', 1), ('Cross Country', 'crossCountry', 'athletics', 2),
  ('Cycling', 'cycling', 'athletics', 3), ('Mountain Biking', 'mountainBiking', 'athletics', 4),
  ('Triathlon', 'triathlon', 'athletics', 5), ('Gymnastics', 'gymnastics', 'athletics', 6),
  ('Tennis', 'tennis', 'racket', 1), ('Squash', 'squash', 'racket', 2),
  ('Table Tennis', 'tableTennis', 'racket', 3), ('Badminton', 'badminton', 'racket', 4),
  ('Swimming', 'swimming', 'water', 1), ('Diving', 'diving', 'water', 2), ('Rowing', 'rowing', 'water', 3),
  ('Canoeing', 'canoeing', 'water', 4), ('Surfing', 'surfing', 'water', 5), ('Lifesaving', 'lifesaving', 'water', 6),
  ('Wrestling', 'wrestling', 'combat', 1), ('Judo', 'judo', 'combat', 2), ('Karate', 'karate', 'combat', 3),
  ('Boxing', 'boxing', 'combat', 4), ('Fencing', 'fencing', 'combat', 5),
  ('Golf', 'golf', 'precision', 1), ('Archery', 'archery', 'precision', 2), ('Shooting', 'shooting', 'precision', 3),
  ('Equestrian', 'equestrian', 'precision', 4), ('Orienteering', 'orienteering', 'precision', 5),
  ('Chess', 'chess', 'mind', 1), ('Indigenous Games', 'indigenousGames', 'mind', 2), ('Dance Sport', 'dance', 'mind', 3);

-- Add the sports that don't exist yet (matching names ignoring case and spaces), then tag them all.
INSERT INTO sports (name)
SELECT c.name FROM sport_catalogue c
 WHERE NOT EXISTS (SELECT 1 FROM sports s WHERE lower(btrim(s.name)) = lower(c.name));

UPDATE sports s SET key = c.key, category = c.category, sort_order = c.sort_order
  FROM sport_catalogue c
 WHERE lower(btrim(s.name)) = lower(c.name);

DROP TABLE sport_catalogue;

-- 2. Favourites ---------------------------------------------------------------------------------
-- A learner's picks shape their feed. (Competitions are followed in competition_follows, migration 010.)
CREATE TABLE IF NOT EXISTS user_favorite_sports (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sport_id INTEGER NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, sport_id)
);

CREATE TABLE IF NOT EXISTS user_favorite_teams (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_user_favorite_teams_team ON user_favorite_teams(team_id);
