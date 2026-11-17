-- Migration 014: Help & Support messages from the apps. Each one is emailed to the support address;
-- this table keeps a copy in case an email goes missing. emailed_at stays NULL when sending failed,
-- so those can be found with: SELECT * FROM support_messages WHERE emailed_at IS NULL;
-- Safe to run more than once. Requires migrations 001 to 013.
CREATE TABLE IF NOT EXISTS support_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- NULL when sent signed out
  email VARCHAR(255) NOT NULL,                                -- where support replies
  name VARCHAR(100),
  topic VARCHAR(20) NOT NULL CHECK (topic IN ('account', 'matches', 'teams', 'other')),
  subject VARCHAR(150) NOT NULL,
  message TEXT NOT NULL,
  platform VARCHAR(10),
  app_version VARCHAR(20),
  emailed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_support_messages_created_at ON support_messages (created_at DESC);
