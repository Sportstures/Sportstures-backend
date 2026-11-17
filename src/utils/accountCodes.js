// Six-digit codes sent by email: signup verification (email_verification_codes) and the account
// changes in account_codes (password reset, email change). Only an HMAC of each code is stored.
const crypto = require('crypto');

const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 10;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;

function generateOtp() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(OTP_LENGTH, '0');
}

function hashOtp(otp) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set. Add it to your .env file.');
  return crypto.createHmac('sha256', secret).update(String(otp)).digest('hex');
}

function sameHash(a, b) {
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// Creates (or replaces) the user's code for `purpose`. Run inside a transaction.
// Returns { otp } or, while the previous code is too new to replace, { retryAfterSeconds }.
async function issueAccountCode(client, userId, purpose, { newEmail = null } = {}) {
  const { rows: [existing] } = await client.query(
    `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (resend_after - NOW()))))::INTEGER AS retry_after,
            resend_after > NOW() AS cooldown_active
       FROM account_codes WHERE user_id = $1 AND purpose = $2 FOR UPDATE`,
    [userId, purpose]
  );
  if (existing && existing.cooldown_active) return { retryAfterSeconds: existing.retry_after };

  const otp = generateOtp();
  await client.query(
    `INSERT INTO account_codes (user_id, purpose, code_hash, new_email, expires_at, resend_after, attempts)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '${OTP_TTL_MINUTES} minutes', NOW() + INTERVAL '${OTP_RESEND_SECONDS} seconds', 0)
     ON CONFLICT (user_id, purpose) DO UPDATE SET
       code_hash = EXCLUDED.code_hash, new_email = EXCLUDED.new_email, expires_at = EXCLUDED.expires_at,
       resend_after = EXCLUDED.resend_after, attempts = 0, created_at = CURRENT_TIMESTAMP`,
    [userId, purpose, hashOtp(otp), newEmail]
  );
  return { otp };
}

// Checks a submitted code. Run inside a transaction. A wrong code counts as an attempt; after
// OTP_MAX_ATTEMPTS the code stops working until a new one is requested.
// Returns { ok: true, newEmail } (and deletes the code), or { ok: false, reason: 'invalid' | 'locked' }.
async function useAccountCode(client, userId, purpose, code) {
  const { rows: [saved] } = await client.query(
    `SELECT code_hash, new_email, attempts, expires_at <= NOW() AS expired
       FROM account_codes WHERE user_id = $1 AND purpose = $2 FOR UPDATE`,
    [userId, purpose]
  );
  if (!saved || saved.expired) return { ok: false, reason: 'invalid' };
  if (saved.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: 'locked' };

  if (!sameHash(saved.code_hash, hashOtp(code))) {
    const attempts = saved.attempts + 1;
    await client.query('UPDATE account_codes SET attempts = $3 WHERE user_id = $1 AND purpose = $2', [userId, purpose, attempts]);
    return { ok: false, reason: attempts >= OTP_MAX_ATTEMPTS ? 'locked' : 'invalid' };
  }

  await client.query('DELETE FROM account_codes WHERE user_id = $1 AND purpose = $2', [userId, purpose]);
  return { ok: true, newEmail: saved.new_email };
}

module.exports = {
  OTP_TTL_MINUTES, OTP_RESEND_SECONDS, OTP_MAX_ATTEMPTS,
  generateOtp, hashOtp, sameHash, issueAccountCode, useAccountCode,
};
