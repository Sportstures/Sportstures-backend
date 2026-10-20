const bcrypt = require('bcrypt');
const pool = require('../../db/config');
const { signAccessToken, generateRefreshToken, hashToken } = require('../utils/tokens');

const BCRYPT_ROUNDS = 12;

// Used so a login for an unknown email takes about as long as one for a real email.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const USER_COLUMNS = 'id, email, first_name, last_name, phone, role, created_at';

function errorBody(code, message) {
  return { error: { code, message } };
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
      `SELECT ${USER_COLUMNS}, password FROM users WHERE email = $1`,
      [email]
    );
    const found = rows[0];

    const matches = await bcrypt.compare(password, found ? found.password : DUMMY_HASH);
    if (!found || !matches) {
      return res.status(401).json(errorBody('INVALID_CREDENTIALS', 'Incorrect email or password'));
    }

    const { password: _omit, ...user } = found;
    const tokens = await issueTokens(user);
    res.json({ user, ...tokens });
  } catch (err) {
    next(err);
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

module.exports = { register, login, refresh, logout, me };
