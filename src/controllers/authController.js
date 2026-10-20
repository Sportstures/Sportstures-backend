const bcrypt = require('bcrypt');
const pool = require('../../db/config');
const { signAccessToken, generateRefreshToken, hashToken } = require('../utils/tokens');
const { USER_SELECT, USER_FROM } = require('../utils/userQuery');

const BCRYPT_ROUNDS = 12;

// Used so a login for an unknown email takes about as long as one for a real email.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

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

// Returns the learner profile (school, grade, sport...) or coach profile for a user, or null.
async function loadProfile(user) {
  if (user.role === 'learner') {
    const { rows } = await pool.query(
      `SELECT lp.grade, lp.class_name, lp.team_name, lp.jersey_number, lp.level,
              s.id AS school_id, s.name AS school_name,
              sp.id AS sport_id, sp.name AS sport_name
         FROM learner_profiles lp
         LEFT JOIN schools s ON s.id = lp.school_id
         LEFT JOIN sports sp ON sp.id = lp.sport_id
        WHERE lp.user_id = $1`,
      [user.id]
    );
    const p = rows[0];
    if (!p) return null;
    return {
      school: p.school_id ? { id: p.school_id, name: p.school_name } : null,
      grade: p.grade,
      className: p.class_name,
      sport: p.sport_id ? { id: p.sport_id, name: p.sport_name } : null,
      teamName: p.team_name,
      jerseyNumber: p.jersey_number,
      level: p.level,
    };
  }

  if (user.role === 'coach') {
    const { rows } = await pool.query(
      'SELECT specialization, years_of_experience, certification, bio FROM coaches WHERE user_id = $1',
      [user.id]
    );
    const c = rows[0];
    if (!c) return null;
    return {
      specialization: c.specialization,
      yearsOfExperience: c.years_of_experience,
      certification: c.certification,
      bio: c.bio,
    };
  }

  return null;
}

async function withProfile(user) {
  return { ...user, profile: await loadProfile(user) };
}

// Finds a school by name (ignoring case) or creates it. Runs inside the register transaction.
async function findOrCreateSchool(client, name) {
  const inserted = await client.query(
    'INSERT INTO schools (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id',
    [name]
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = await client.query('SELECT id FROM schools WHERE lower(name) = lower($1)', [name]);
  return existing.rows[0].id;
}

async function register(req, res, next) {
  const {
    email, password, firstName, lastName, phone, dateOfBirth, gender,
    role = 'learner', school, sport, coach,
  } = req.body;

  let client;
  try {
    // Sport must be one of the seeded sports (see GET /api/sports).
    let sportId = null;
    if (role === 'learner' && sport && sport.name) {
      const found = await pool.query('SELECT id FROM sports WHERE lower(name) = lower($1)', [sport.name]);
      if (!found.rows[0]) {
        return res.status(400).json(errorBody('UNKNOWN_SPORT', 'Unknown sport, use GET /api/sports for valid names'));
      }
      sportId = found.rows[0].id;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    client = await pool.connect();
    await client.query('BEGIN');

    // Only 'learner' and 'coach' can be chosen here (validated in the route). Admins are set manually.
    const roleRow = await client.query('SELECT id FROM roles WHERE name = $1', [role]);
    const inserted = await client.query(
      `INSERT INTO users (email, password, first_name, last_name, phone, date_of_birth, gender, role_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [email, passwordHash, firstName || null, lastName || null, phone || null,
        dateOfBirth || null, gender || null, roleRow.rows[0].id]
    );
    const userId = inserted.rows[0].id;

    if (role === 'learner') {
      const schoolId = school && school.name ? await findOrCreateSchool(client, school.name) : null;
      const hasProfile = schoolId || sportId || school || sport;
      if (hasProfile) {
        await client.query(
          `INSERT INTO learner_profiles
             (user_id, school_id, grade, class_name, sport_id, team_name, jersey_number, level)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            userId, schoolId,
            school?.grade ?? null, school?.className || null,
            sportId, sport?.teamName || null, sport?.jerseyNumber ?? null, sport?.level || null,
          ]
        );
      }
    } else if (role === 'coach') {
      await client.query(
        `INSERT INTO coaches (user_id, specialization, years_of_experience, certification, bio)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, coach?.specialization || null, coach?.yearsOfExperience ?? null,
          coach?.certification || null, coach?.bio || null]
      );
    }

    await client.query('COMMIT');

    const { rows } = await pool.query(`SELECT ${USER_SELECT} ${USER_FROM} WHERE u.id = $1`, [userId]);
    const user = await withProfile(rows[0]);
    const tokens = await issueTokens(user);
    res.status(201).json({ user, ...tokens });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    // 23505 = unique_violation (email already registered)
    if (err.code === '23505') {
      return res.status(409).json(errorBody('EMAIL_TAKEN', 'An account with this email already exists'));
    }
    next(err);
  } finally {
    if (client) client.release();
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    const { rows } = await pool.query(
      `SELECT ${USER_SELECT}, u.password ${USER_FROM} WHERE u.email = $1`,
      [email]
    );
    const found = rows[0];

    const matches = await bcrypt.compare(password, found ? found.password : DUMMY_HASH);
    if (!found || !matches) {
      return res.status(401).json(errorBody('INVALID_CREDENTIALS', 'Incorrect email or password'));
    }

    const { password: _omit, ...plainUser } = found;
    const user = await withProfile(plainUser);
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

    const userResult = await pool.query(`SELECT ${USER_SELECT} ${USER_FROM} WHERE u.id = $1`, [stored.user_id]);
    if (!userResult.rows[0]) {
      return res.status(401).json(errorBody('INVALID_REFRESH_TOKEN', 'Invalid refresh token'));
    }
    const user = await withProfile(userResult.rows[0]);

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
async function me(req, res, next) {
  try {
    res.json({ user: await withProfile(req.user) });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, refresh, logout, me };
