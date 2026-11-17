-- Migration 012: coaches invite coaches from other schools.
-- Safe to run more than once. Requires migrations 001 to 011.
--
-- Two kinds of invitation share one table:
--   'email' - the coach typed a school email address and the system emailed a registration link.
--   'link'  - the coach copied a link to share (WhatsApp, social media...). One reusable link per coach.
-- `code` is the unguessable token in the link. Everyone who signs up with a code gets
-- users.invitation_id set, so we can show the inviter who joined.
CREATE TABLE IF NOT EXISTS invitations (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(64) NOT NULL UNIQUE,
  inviter_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          VARCHAR(10) NOT NULL CHECK (kind IN ('email', 'link')),
  email         VARCHAR(255),
  email_sent_at TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT invitations_email_needed CHECK (kind <> 'email' OR email IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_invitations_inviter ON invitations (inviter_id);
-- A coach can only have one pending invitation per email address, and one share link.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_one_link ON invitations (inviter_id) WHERE kind = 'link' AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_one_per_email ON invitations (inviter_id, lower(email)) WHERE kind = 'email' AND revoked_at IS NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS invitation_id INTEGER REFERENCES invitations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_invitation ON users (invitation_id) WHERE invitation_id IS NOT NULL;
