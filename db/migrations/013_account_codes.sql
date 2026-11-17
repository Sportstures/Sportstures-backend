-- Migration 013: one-time codes for account changes after signup: resetting a forgotten password,
-- and confirming a new email address. (Signup codes stay in email_verification_codes.)
-- One live code per user and purpose; a new request replaces the old code.
-- Safe to run more than once. Requires migrations 001 to 012.
CREATE TABLE IF NOT EXISTS account_codes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose VARCHAR(20) NOT NULL CHECK (purpose IN ('password_reset', 'email_change')),
  code_hash CHAR(64) NOT NULL,
  new_email VARCHAR(255),
  expires_at TIMESTAMPTZ NOT NULL,
  resend_after TIMESTAMPTZ NOT NULL,
  attempts SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, purpose)
);
