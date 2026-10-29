const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('../../db/config');
const { signAccessToken, generateRefreshToken, hashToken } = require('../utils/tokens');
const { sendVerificationCode } = require('../utils/email');

const BCRYPT_ROUNDS = 12;
const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 10;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;

// Used so a login for an unknown email takes about as long as one for a real email.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const USER_COLUMNS = 'id, email, first_name, last_name, phone, role, created_at';

function errorBody(code, message) {
  return { error: { code, message } };
}

function generateOtp() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(OTP_LENGTH, '0');
}

function hashOtp(otp) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set. Add it to your .env file.');
  return crypto.createHmac('sha256', secret).update(otp).digest('hex');
}

function saveOtp(client, userId, otp) {
  return client.query(
    `INSERT INTO email_verification_codes
       (user_id, code_hash, expires_at, resend_after, attempts)
     VALUES ($1, $2, NOW() + INTERVAL '${OTP_TTL_MINUTES} minutes',
       NOW() + INTERVAL '${OTP_RESEND_SECONDS} seconds', 0)
     ON CONFLICT (user_id) DO UPDATE SET
       code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at,
       resend_after = EXCLUDED.resend_after,
       attempts = 0`,
    [userId, hashOtp(otp)]
  );
}

async function registerPlayer(req, res, next) {
  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    const { email, password, firstName, lastName, dateOfBirth, gender, school, sport } = req.body;
    await client.query('BEGIN');
    transactionStarted = true;

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { rows } = await client.query(
      `INSERT INTO users (email, password, first_name, last_name, role, email_verified)
       VALUES ($1, $2, $3, $4, 'player', FALSE)
       RETURNING id`,
      [email, passwordHash, firstName, lastName]
    );
    const userId = rows[0].id;

    await client.query(
      `INSERT INTO player_profiles
         (user_id, date_of_birth, gender, school_name, grade, class_name,
          sport_name, team_name, jersey_number, sport_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        dateOfBirth,
        gender,
        school.name,
        school.grade,
        school.className,
        sport ? sport.name : null,
        sport ? sport.teamName || null : null,
        sport && sport.jerseyNumber !== undefined ? sport.jerseyNumber : null,
        sport ? sport.level || null : null,
      ]
    );

    const otp = generateOtp();
    await saveOtp(client, userId, otp);
    await sendVerificationCode(email, otp);
    await client.query('COMMIT');
    transactionStarted = false;

    res.status(201).json({ userId });
  } catch (err) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        return next(rollbackError);
      }
    }
    if (err.code === '23505') {
      return res.status(409).json(errorBody('EMAIL_TAKEN', 'An account with this email already exists'));
    }
    next(err);
  } finally {
    if (client) client.release();
  }
}

// Creates an access + refresh token pair and stores the refresh token hash.
async function issueTokens(user) {
  const refresh = generateRefreshToken();
  await pool.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, refresh.tokenHash, refresh.expiresAt]
  );
  return {
    accessToken: signAccessToken(user),
    refreshToken: refresh.token,
  };
}

async function register(req, res, next) {
  if (req.body.role === 'player') return registerPlayer(req, res, next);

  try {
    const { email, password, firstName, lastName, phone } = req.body;

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Role is never taken from the request: everyone registers as a plain 'user'.
    const { rows } = await pool.query(
      `INSERT INTO users (email, password, first_name, last_name, phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${USER_COLUMNS}`,
      [email, passwordHash, firstName || null, lastName || null, phone || null]
    );

    const user = rows[0];
    const tokens = await issueTokens(user);
    res.status(201).json({ user, ...tokens });
  } catch (err) {
    // 23505 = unique_violation (email already registered)
    if (err.code === '23505') {
      return res.status(409).json(errorBody('EMAIL_TAKEN', 'An account with this email already exists'));
    }
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    const { rows } = await pool.query(
      `SELECT ${USER_COLUMNS}, password, email_verified FROM users WHERE email = $1`,
      [email]
    );
    const found = rows[0];

    const matches = await bcrypt.compare(password, found ? found.password : DUMMY_HASH);
    if (!found || !matches) {
      return res.status(401).json(errorBody('INVALID_CREDENTIALS', 'Incorrect email or password'));
    }
    if (!found.email_verified) {
      return res.status(403).json(errorBody('EMAIL_NOT_VERIFIED', 'Verify your email before logging in'));
    }

    const { password: _omit, email_verified: _verified, ...user } = found;
    const tokens = await issueTokens(user);
    res.json({ user, ...tokens });
  } catch (err) {
    next(err);
  }
}

async function verifyOtp(req, res, next) {
  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    const { email, otp } = req.body;
    await client.query('BEGIN');
    transactionStarted = true;

    const { rows: userRows } = await client.query(
      'SELECT id, email_verified FROM users WHERE email = $1 FOR UPDATE',
      [email]
    );
    const user = userRows[0];
    if (!user || user.email_verified) {
      await client.query('COMMIT');
      transactionStarted = false;
      return res.status(400).json(errorBody('INVALID_OTP', 'The code is invalid or expired'));
    }

    const { rows: codeRows } = await client.query(
      `SELECT code_hash, expires_at <= NOW() AS expired, attempts
       FROM email_verification_codes WHERE user_id = $1 FOR UPDATE`,
      [user.id]
    );
    const savedCode = codeRows[0];
    if (!savedCode || savedCode.expired) {
      await client.query('COMMIT');
      transactionStarted = false;
      return res.status(400).json(errorBody('INVALID_OTP', 'The code is invalid or expired'));
    }

    if (savedCode.attempts >= OTP_MAX_ATTEMPTS) {
      await client.query('COMMIT');
      transactionStarted = false;
      return res.status(429).json(errorBody('TOO_MANY_REQUESTS', 'Too many incorrect codes; request a new code'));
    }

    const submittedHash = hashOtp(otp);
    const matches = crypto.timingSafeEqual(
      Buffer.from(savedCode.code_hash, 'hex'),
      Buffer.from(submittedHash, 'hex')
    );
    if (!matches) {
      const attempts = savedCode.attempts + 1;
      await client.query(
        'UPDATE email_verification_codes SET attempts = $2 WHERE user_id = $1',
        [user.id, attempts]
      );
      await client.query('COMMIT');
      transactionStarted = false;
      if (attempts >= OTP_MAX_ATTEMPTS) {
        return res.status(429).json(errorBody('TOO_MANY_REQUESTS', 'Too many incorrect codes; request a new code'));
      }
      return res.status(400).json(errorBody('INVALID_OTP', 'The code is invalid or expired'));
    }

    await client.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [user.id]);
    await client.query('DELETE FROM email_verification_codes WHERE user_id = $1', [user.id]);
    await client.query('COMMIT');
    transactionStarted = false;
    res.json({ message: 'Account verified. You can now log in.' });
  } catch (err) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        return next(rollbackError);
      }
    }
    next(err);
  } finally {
    if (client) client.release();
  }
}

async function resendOtp(req, res, next) {
  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    const { email } = req.body;
    await client.query('BEGIN');
    transactionStarted = true;

    const { rows: userRows } = await client.query(
      'SELECT id, email_verified FROM users WHERE email = $1 FOR UPDATE',
      [email]
    );
    const user = userRows[0];
    if (!user || user.email_verified) {
      await client.query('COMMIT');
      transactionStarted = false;
      return res.json({ message: 'If the account is awaiting verification, a new code has been sent' });
    }

    const { rows: codeRows } = await client.query(
      `SELECT resend_after > NOW() AS cooldown_active,
              GREATEST(1, CEIL(EXTRACT(EPOCH FROM (resend_after - NOW()))))::INTEGER AS retry_after
       FROM email_verification_codes WHERE user_id = $1 FOR UPDATE`,
      [user.id]
    );
    const existingCode = codeRows[0];
    if (existingCode && existingCode.cooldown_active) {
      await client.query('COMMIT');
      transactionStarted = false;
      res.set('Retry-After', String(existingCode.retry_after));
      return res.status(429).json(errorBody('TOO_MANY_REQUESTS', 'Please wait before requesting another code'));
    }

    const otp = generateOtp();
    await saveOtp(client, user.id, otp);
    await sendVerificationCode(email, otp);
    await client.query('COMMIT');
    transactionStarted = false;
    res.json({ message: 'If the account is awaiting verification, a new code has been sent' });
  } catch (err) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        return next(rollbackError);
      }
    }
    next(err);
  } finally {
    if (client) client.release();
  }
}

// Exchanges a refresh token for a new pair. The old refresh token is revoked (rotation).
async function refresh(req, res, next) {
  try {
    const tokenHash = hashToken(req.body.refreshToken);

    const { rows } = await pool.query(
      'SELECT id, user_id, expires_at, revoked FROM refresh_tokens WHERE token_hash = $1',
      [tokenHash]
    );
    const stored = rows[0];

    if (!stored) {
      return res.status(401).json(errorBody('INVALID_REFRESH_TOKEN', 'Invalid refresh token'));
    }

    // A revoked token being used again suggests it was stolen: revoke the whole family.
    if (stored.revoked) {
      await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [stored.user_id]);
      return res.status(401).json(errorBody('INVALID_REFRESH_TOKEN', 'Invalid refresh token'));
    }

    if (new Date(stored.expires_at) < new Date()) {
      return res.status(401).json(errorBody('REFRESH_TOKEN_EXPIRED', 'Refresh token expired, please log in again'));
    }

    const userResult = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [stored.user_id]);
    const user = userResult.rows[0];
    if (!user) {
      return res.status(401).json(errorBody('INVALID_REFRESH_TOKEN', 'Invalid refresh token'));
    }

    await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1', [stored.id]);
    const tokens = await issueTokens(user);
    res.json({ user, ...tokens });
  } catch (err) {
    next(err);
  }
}

// Revokes the given refresh token. Always succeeds so clients can safely call it.
async function logout(req, res, next) {
  try {
    await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1', [
      hashToken(req.body.refreshToken),
    ]);
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
}

// Requires the authenticate middleware, which sets req.user.
function me(req, res) {
  res.json({ user: req.user });
}

module.exports = { register, login, verifyOtp, resendOtp, refresh, logout, me };
