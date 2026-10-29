const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('../../db/config');
const { signAccessToken, generateRefreshToken, hashToken } = require('../utils/tokens');
const { sendVerificationCode } = require('../utils/email');
const { USER_SELECT, USER_FROM } = require('../utils/userQuery');
const { findOrCreateSchool } = require('../utils/schools');
const { findOrCreateSport } = require('../utils/sports');

const BCRYPT_ROUNDS = 12;
const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 10;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;

// Used so a login for an unknown email takes about as long as one for a real email.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

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
    const { email, password, firstName, lastName, dateOfBirth, gender, school, sport } = req.body;
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    const { rows: roleRows } = await client.query(
      'SELECT id FROM roles WHERE name = $1',
      ['learner']
    );
    if (!roleRows[0]) throw new Error('Learner role is not configured in the roles table');

    const schoolId = await findOrCreateSchool(client, school.name);
    const sportRecord = sport && sport.name ? await findOrCreateSport(client, sport.name) : null;
    const { rows: userRows } = await client.query(
      `INSERT INTO users
         (email, password, first_name, last_name, date_of_birth, gender, role_id, email_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
       RETURNING id`,
      [email, passwordHash, firstName, lastName, dateOfBirth, gender, roleRows[0].id]
    );
    const userId = userRows[0].id;

    await client.query(
      `INSERT INTO learner_profiles
         (user_id, school_id, grade, class_name, sport_id, team_name, jersey_number, level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        schoolId,
        school.grade,
        school.className,
        sportRecord ? sportRecord.id : null,
        sport ? sport.teamName || null : null,
        sport && sport.jerseyNumber !== undefined ? sport.jerseyNumber : null,
        sport ? sport.level || null : null,
      ]
    );

    const otp = generateOtp();
    await saveOtp(client, userId, otp);
    await sendVerificationCode(email, otp, { firstName, expiresInMinutes: OTP_TTL_MINUTES });
    await client.query('COMMIT');
    transactionStarted = false;

    return res.status(201).json({ userId });
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

async function registerCoach(req, res, next) {
  let client;
  let transactionStarted = false;
  try {
    const {
      email, password, firstName, lastName, dateOfBirth, gender, school,
      coachingRole, experience, team,
    } = req.body;
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    const { rows: roleRows } = await client.query(
      'SELECT id FROM roles WHERE name = $1',
      ['coach']
    );
    if (!roleRows[0]) throw new Error('Coach role is not configured in the roles table');

    const schoolId = await findOrCreateSchool(client, school);
    const sport = await findOrCreateSport(client, team.sport);
    const { rows: userRows } = await client.query(
      `INSERT INTO users
         (email, password, first_name, last_name, date_of_birth, gender, role_id, email_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
       RETURNING id`,
      [email, passwordHash, firstName, lastName, dateOfBirth, gender, roleRows[0].id]
    );
    const userId = userRows[0].id;

    await client.query(
      `INSERT INTO coaches (user_id, school_id, team_name, team_level, coaching_role, experience)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, schoolId, team.name, team.level, coachingRole, experience]
    );
    await client.query(
      `INSERT INTO teams (name, coach_id, school_id, sport_id, level)
       VALUES ($1, $2, $3, $4, $5)`,
      [team.name, userId, schoolId, sport.id, team.level]
    );

    const otp = generateOtp();
    await saveOtp(client, userId, otp);
    await sendVerificationCode(email, otp, { firstName, expiresInMinutes: OTP_TTL_MINUTES });
    await client.query('COMMIT');
    transactionStarted = false;

    return res.status(201).json({ userId, status: 'pending_verification' });
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
    return next(err);
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
      `SELECT c.id, c.team_name, c.team_level, c.coaching_role, c.experience,
              s.id AS school_id, s.name AS school_name,
              t.id AS team_id, t.name AS team_name_actual, t.level AS team_level_actual,
              ts.id AS team_sport_id, ts.name AS team_sport_name,
              tsc.id AS team_school_id, tsc.name AS team_school_name
         FROM coaches c
         LEFT JOIN schools s ON s.id = c.school_id
         LEFT JOIN teams t ON t.coach_id = c.user_id
         LEFT JOIN sports ts ON ts.id = t.sport_id
         LEFT JOIN schools tsc ON tsc.id = t.school_id
        WHERE c.user_id = $1`,
      [user.id]
    );
    const c = rows[0];
    if (!c) return null;
    const team = c.team_id ? {
      id: c.team_id,
      name: c.team_name_actual,
      level: c.team_level_actual,
      sport: c.team_sport_id ? { id: c.team_sport_id, name: c.team_sport_name } : null,
      school: c.team_school_id ? { id: c.team_school_id, name: c.team_school_name } : null,
    } : null;
    return {
      school: c.school_id ? { id: c.school_id, name: c.school_name } : null,
      teamName: team ? team.name : c.team_name,
      teamLevel: team ? team.level : c.team_level,
      coachingRole: c.coaching_role,
      experience: c.experience,
      team,
      sports: team && team.sport ? [team.sport] : [],
    };
  }

  return null;
}

async function withProfile(user) {
  const profile = await loadProfile(user);
  return {
    ...user,
    firstName: user.first_name,
    lastName: user.last_name,
    dateOfBirth: user.date_of_birth,
    createdAt: user.created_at,
    profile,
    ...(user.role === 'coach' ? { team: profile ? profile.team : null } : {}),
  };
}

async function register(req, res, next) {
  if (['player', 'learner'].includes(req.body.role)) return registerPlayer(req, res, next);

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

    // A coach can coach several sports; each must be a known sport.
    const coachSportIds = [];
    if (role === 'coach' && Array.isArray(coach?.sports)) {
      for (const name of new Set(coach.sports.map((s) => String(s).toLowerCase()))) {
        const found = await pool.query('SELECT id FROM sports WHERE lower(name) = $1', [name]);
        if (!found.rows[0]) {
          return res.status(400).json(errorBody('UNKNOWN_SPORT', `Unknown sport "${name}", use GET /api/sports for valid names`));
        }
        coachSportIds.push(found.rows[0].id);
      }
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
      const schoolId = coach?.school ? await findOrCreateSchool(client, coach.school) : null;
      const coachRow = await client.query(
        `INSERT INTO coaches (user_id, school_id, team_name, team_level, coaching_role, experience)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [userId, schoolId, coach?.teamName || null, coach?.teamLevel || null,
          coach?.coachingRole || null, coach?.experience || null]
      );
      for (const sportIdToAdd of coachSportIds) {
        await client.query('INSERT INTO coach_sports (coach_id, sport_id) VALUES ($1, $2)', [
          coachRow.rows[0].id,
          sportIdToAdd,
        ]);
      }
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
      `SELECT ${USER_SELECT}, u.password, u.email_verified
         ${USER_FROM}
        WHERE u.email = $1`,
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

    const { password: _omit, email_verified: _verified, ...userRow } = found;
    const user = await withProfile(userRow);
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
    const { email, code, otp } = req.body;
    await client.query('BEGIN');
    transactionStarted = true;

    const { rows: userRows } = await client.query(
      `SELECT u.id, u.email_verified, r.name AS role
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.email = $1
        FOR UPDATE OF u`,
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

    const submittedHash = hashOtp(code || otp);
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

    if (user.role === 'coach') {
      client.release();
      client = null;
      const { rows: verifiedUserRows } = await pool.query(
        `SELECT ${USER_SELECT} ${USER_FROM} WHERE u.id = $1`,
        [user.id]
      );
      const verifiedUser = await withProfile(verifiedUserRows[0]);
      const tokens = await issueTokens(verifiedUser);
      return res.json({ ...tokens, user: verifiedUser });
    }

    return res.json({ message: 'Account verified. You can now log in.' });
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
      'SELECT id, first_name, email_verified FROM users WHERE email = $1 FOR UPDATE',
      [email]
    );
    const user = userRows[0];
    if (!user || user.email_verified) {
      await client.query('COMMIT');
      transactionStarted = false;
      return res.json({ retryAfterSeconds: 0 });
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
    await sendVerificationCode(email, otp, { firstName: user.first_name, expiresInMinutes: OTP_TTL_MINUTES });
    await client.query('COMMIT');
    transactionStarted = false;
    res.json({ retryAfterSeconds: OTP_RESEND_SECONDS });
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

module.exports = { register, registerCoach, login, verifyOtp, resendOtp, refresh, logout, me };
