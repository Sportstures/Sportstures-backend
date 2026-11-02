-- Migration 006: match reports (one per fixture).
-- Safe to run more than once. Requires migrations 001 to 005.
-- Final scores need no new table: they use the existing `scores` table (one row per fixture).

CREATE TABLE IF NOT EXISTS fixture_reports (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL UNIQUE REFERENCES fixtures(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Lets the "results" and "upcoming" lists filter by status quickly.
CREATE INDEX IF NOT EXISTS idx_fixtures_status ON fixtures(status);
