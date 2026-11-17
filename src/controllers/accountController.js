// Changing an account after signup: profile details, password (change and forgot/reset) and email.
const bcrypt = require('bcrypt');
const pool = require('../../db/config');
const { USER_SELECT, USER_FROM } = require('../utils/userQuery');
const { findOrCreateSchool } = require('../utils/schools');
const { findOrCreateSport } = require('../utils/sports');
const { sendVerificationCode, sendAccountNotice } = require('../utils/email');
const { issueAccountCode, useAccountCode, OTP_TTL_MINUTES, OTP_RESEND_SECONDS } = require('../utils/accountCodes');
const { withProfile, issueTokens, BCRYPT_ROUNDS } = require('./authController');

function errorBody(code, message) {
  return { error: { code, message } };
}

// Thrown inside a transaction to roll it back and answer 400 with `body`.
class Problem extends Error {
  constructor(code, message) {
    super(message);
    this.body = errorBody(code, message);
  }
}

// Runs fn(client) in a transaction and always releases the client.
async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function loadUser(id) {
  const { rows } = await pool.query(`SELECT ${USER_SELECT} ${USER_FROM} WHERE u.id = $1`, [id]);
  return withProfile(rows[0]);
}

// Security notices are a courtesy: the change itself has already succeeded, so a mail failure is only logged.
function notify(email, kind, details) {
  sendAccountNotice(email, kind, details).catch((err) => console.error(`Account notice (${kind}) failed:`, err.message));
}

function codeFailure(res, reason) {
  if (reason === 'locked') {
    return res.status(429).json(errorBody('TOO_MANY_REQUESTS', 'Too many incorrect codes; request a new code'));
  }
  return res.status(400).json(errorBody('INVALID_OTP', 'The code is invalid or expired'));
}

async function passwordMatches(userId, password) {
  const { rows: [row] } = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
  return Boolean(row) && bcrypt.compare(password, row.password);
}

// Adds "column = $n" for each change; `values` collects the parameters.
function setter(values) {
  const sets = [];
  return {
    sets,
    add(column, value) {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    },
  };
}

const emptyToNull = (value) => (value === '' || value === undefined ? null : value);

// PATCH /api/me/profile: change any of my profile details. Only the fields sent are changed.
async function updateProfile(req, res, next) {
  try {
    const b = req.body;
    if (b.email !== undefined) {
      return res.status(400).json(errorBody('USE_EMAIL_ENDPOINT', 'Change your email with POST /api/me/email'));
    }
    if (b.password !== undefined || b.newPassword !== undefined) {
      return res.status(400).json(errorBody('USE_PASSWORD_ENDPOINT', 'Change your password with PUT /api/me/password'));
    }
    const isLearner = req.user.role === 'learner';
    if (!isLearner && (b.school !== undefined || b.sport !== undefined)) {
      return res.status(403).json(errorBody('LEARNER_ONLY', 'Only learners can change school and sport details here'));
    }

    const userValues = [];
    const user = setter(userValues);
    if (b.firstName !== undefined) user.add('first_name', b.firstName);
    if (b.lastName !== undefined) user.add('last_name', b.lastName);
    if (b.phone !== undefined) user.add('phone', emptyToNull(b.phone));
    if (b.dateOfBirth !== undefined) user.add('date_of_birth', b.dateOfBirth);
    if (b.gender !== undefined) user.add('gender', b.gender);

    const school = b.school || {};
    const sport = b.sport;
    const hasProfileChange = isLearner && (Object.keys(school).length > 0 || sport !== undefined);
    if (user.sets.length === 0 && !hasProfileChange) {
      return res.status(400).json(errorBody('NOTHING_TO_UPDATE', 'Send at least one field to change'));
    }

    const problem = await inTransaction(async (client) => {
      if (user.sets.length) {
        userValues.push(req.user.id);
        await client.query(
          `UPDATE users SET ${user.sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${userValues.length}`,
          userValues
        );
      }
      if (!hasProfileChange) return null;

      const { rows: [current] } = await client.query(
        'SELECT sport_id FROM learner_profiles WHERE user_id = $1 FOR UPDATE',
        [req.user.id]
      );
      if (!current) throw new Problem('NO_PROFILE', 'This account has no learner profile');

      const values = [];
      const profile = setter(values);
      if (school.name !== undefined) {
        profile.add('school_id', await findOrCreateSchool(client, school.name, { province: school.province, town: school.town }));
      }
      if (school.grade !== undefined) profile.add('grade', school.grade);
      if (school.className !== undefined) profile.add('class_name', school.className);

      if (sport === null) {
        // "No sport": clear the sport and everything that belongs to it.
        ['sport_id', 'team_name', 'jersey_number', 'level'].forEach((column) => profile.add(column, null));
      } else if (sport) {
        if (sport.name !== undefined) {
          profile.add('sport_id', (await findOrCreateSport(client, sport.name)).id);
        } else if (!current.sport_id) {
          throw new Problem('SPORT_REQUIRED', 'Send sport.name: you have no sport yet');
        }
        if (sport.teamName !== undefined) profile.add('team_name', emptyToNull(sport.teamName));
        if (sport.jerseyNumber !== undefined) profile.add('jersey_number', emptyToNull(sport.jerseyNumber));
        if (sport.level !== undefined) profile.add('level', emptyToNull(sport.level));
      }

      if (profile.sets.length) {
        values.push(req.user.id);
        await client.query(
          `UPDATE learner_profiles SET ${profile.sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE user_id = $${values.length}`,
          values
        );
      }
      return null;
    }).catch((err) => {
      if (err instanceof Problem) return err.body;
      throw err;
    });

    if (problem) return res.status(400).json(problem);
    res.json({ user: await loadUser(req.user.id) });
  } catch (err) {
    next(err);
  }
}

// PUT /api/me/password: change my password. Signs out every other device; returns fresh tokens for this one.
async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!(await passwordMatches(req.user.id, currentPassword))) {
      return res.status(400).json(errorBody('WRONG_PASSWORD', 'Your current password is incorrect'));
    }
    if (currentPassword === newPassword) {
      return res.status(400).json(errorBody('SAME_PASSWORD', 'Choose a password different from your current one'));
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await inTransaction(async (client) => {
      await client.query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [hash, req.user.id]);
      await client.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1 AND revoked = FALSE', [req.user.id]);
      await client.query("DELETE FROM account_codes WHERE user_id = $1 AND purpose = 'password_reset'", [req.user.id]);
    });

    const user = await loadUser(req.user.id);
    const tokens = await issueTokens(user);
    notify(user.email, 'password_changed', { firstName: user.first_name });
    res.json({ message: 'Password changed', user, ...tokens });
  } catch (err) {
    next(err);
  }
}

// POST /api/me/email: start changing my email. Sends a code to the NEW address; nothing changes until
// it is confirmed with POST /api/me/email/verify.
async function requestEmailChange(req, res, next) {
  try {
    const { newEmail, password } = req.body;
    if (!(await passwordMatches(req.user.id, password))) {
      return res.status(400).json(errorBody('WRONG_PASSWORD', 'Your password is incorrect'));
    }
    if (newEmail === req.user.email) {
      return res.status(400).json(errorBody('SAME_EMAIL', 'That is already your email address'));
    }
    const { rows: taken } = await pool.query('SELECT 1 FROM users WHERE email = $1', [newEmail]);
    if (taken.length) {
      return res.status(409).json(errorBody('EMAIL_TAKEN', 'An account with this email already exists'));
    }

    const issued = await inTransaction(async (client) => {
      const result = await issueAccountCode(client, req.user.id, 'email_change', { newEmail });
      if (result.otp) {
        await sendVerificationCode(newEmail, result.otp, {
          firstName: req.user.first_name, expiresInMinutes: OTP_TTL_MINUTES, purpose: 'email_change',
        });
      }
      return result;
    });
    if (issued.retryAfterSeconds) {
      res.set('Retry-After', String(issued.retryAfterSeconds));
      return res.status(429).json(errorBody('TOO_MANY_REQUESTS', 'Please wait before requesting another code'));
    }

    res.json({ email: newEmail, expiresInMinutes: OTP_TTL_MINUTES, retryAfterSeconds: OTP_RESEND_SECONDS });
  } catch (err) {
    next(err);
  }
}

// POST /api/me/email/verify: confirm the new email with the code sent to it.
async function confirmEmailChange(req, res, next) {
  try {
    const oldEmail = req.user.email;
    const outcome = await inTransaction(async (client) => {
      const used = await useAccountCode(client, req.user.id, 'email_change', req.body.code);
      if (!used.ok) return used;
      await client.query(
        'UPDATE users SET email = $1, email_verified = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [used.newEmail, req.user.id]
      );
      return used;
    });
    if (!outcome.ok) return codeFailure(res, outcome.reason);

    const user = await loadUser(req.user.id);
    notify(oldEmail, 'email_changed', { firstName: user.first_name, newEmail: user.email });
    res.json({ user });
  } catch (err) {
    // Someone signed up with the new address after the code was sent.
    if (err.code === '23505') {
      return res.status(409).json(errorBody('EMAIL_TAKEN', 'An account with this email already exists'));
    }
    next(err);
  }
}

// POST /api/auth/forgot-password: email a reset code. Always answers the same way, so it cannot be
// used to find out which emails have accounts.
async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    const { rows: [user] } = await pool.query('SELECT id, first_name FROM users WHERE email = $1', [email]);
    if (user) {
      await inTransaction(async (client) => {
        const result = await issueAccountCode(client, user.id, 'password_reset');
        if (result.otp) {
          await sendVerificationCode(email, result.otp, {
            firstName: user.first_name, expiresInMinutes: OTP_TTL_MINUTES, purpose: 'password_reset',
          });
        }
      });
    }
    res.json({
      message: 'If an account exists for this email, a reset code has been sent',
      expiresInMinutes: OTP_TTL_MINUTES,
      retryAfterSeconds: OTP_RESEND_SECONDS,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/reset-password: set a new password with the emailed code. Signs out every device.
async function resetPassword(req, res, next) {
  try {
    const { email, code, newPassword } = req.body;
    const { rows: [user] } = await pool.query('SELECT id, first_name FROM users WHERE email = $1', [email]);
    if (!user) return codeFailure(res, 'invalid');

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const outcome = await inTransaction(async (client) => {
      const used = await useAccountCode(client, user.id, 'password_reset', code);
      if (!used.ok) return used;
      // The code proves they own the address, so an unverified signup is verified too.
      await client.query(
        'UPDATE users SET password = $1, email_verified = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [hash, user.id]
      );
      await client.query('DELETE FROM email_verification_codes WHERE user_id = $1', [user.id]);
      await client.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1 AND revoked = FALSE', [user.id]);
      return used;
    });
    if (!outcome.ok) return codeFailure(res, outcome.reason);

    notify(email, 'password_changed', { firstName: user.first_name });
    res.json({ message: 'Password reset. You can now log in.' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  updateProfile, changePassword, requestEmailChange, confirmEmailChange, forgotPassword, resetPassword,
};
