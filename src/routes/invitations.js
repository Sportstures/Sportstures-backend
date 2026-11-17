// Coaches inviting coaches from other schools, mounted under /api/invitations.
//   POST   /            invite by email (body { email }) or get the shareable link (no body)
//   GET    /            my invitations and who joined
//   DELETE /:id         cancel one of mine
//   GET    /:code       public: is this invitation valid, and who is it from (for the signup page)
const express = require('express');
const crypto = require('crypto');
const { body, param } = require('express-validator');
const rateLimit = require('express-rate-limit');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendCoachInvitation } = require('../utils/email');
const { errorBody } = require('../utils/serializers');

const router = express.Router();

const EXPIRES_DAYS = 14;
const LINK_EXPIRES_DAYS = 90;
const DAILY_EMAIL_LIMIT = Number(process.env.INVITE_EMAILS_PER_DAY) || 20;

// Where invited coaches land. Set WEBSITE_URL on the server (e.g. https://sportstures.co.za).
const websiteUrl = () => (process.env.WEBSITE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const linkFor = (code) => `${websiteUrl()}/signup?invite=${encodeURIComponent(code)}`;
const newCode = () => crypto.randomBytes(24).toString('base64url');

// Stops one account or address from sending a flood of emails or guessing codes.
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.OTP_RATE_LIMIT_MAX) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: errorBody('TOO_MANY_REQUESTS', 'Too many attempts, try again later'),
});

// Status is worked out from the row, never stored, so it cannot go out of date.
const STATUS_SQL = `CASE
    WHEN i.revoked_at IS NOT NULL THEN 'cancelled'
    WHEN i.kind = 'email' AND EXISTS (SELECT 1 FROM users u WHERE u.invitation_id = i.id) THEN 'accepted'
    WHEN i.expires_at < NOW() THEN 'expired'
    ELSE 'pending' END`;
const JOINED_SQL = '(SELECT count(*)::int FROM users u WHERE u.invitation_id = i.id)';

const map = (row) => ({
  id: row.id,
  kind: row.kind,
  email: row.email,
  status: row.status,
  link: linkFor(row.code),
  code: row.code,
  joined: row.joined,
  emailSent: Boolean(row.email_sent_at),
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

const SELECT = `SELECT i.*, ${STATUS_SQL} AS status, ${JOINED_SQL} AS joined FROM invitations i`;

async function inviterDetails(userId) {
  const { rows } = await pool.query(
    `SELECT u.first_name, u.last_name, s.name AS school
       FROM users u LEFT JOIN coaches c ON c.user_id = u.id LEFT JOIN schools s ON s.id = c.school_id
      WHERE u.id = $1`,
    [userId]
  );
  const r = rows[0] || {};
  return { inviterName: [r.first_name, r.last_name].filter(Boolean).join(' '), schoolName: r.school || null };
}

// POST /api/invitations
//   { "email": "head@otherschool.co.za" }  -> emails an invitation (201, or 200 if it was already sent: it is sent again)
//   {}                                     -> returns my shareable link (creates it the first time)
router.post(
  '/',
  authenticate,
  requireRole('coach', 'admin'),
  [body('email').optional({ values: 'falsy' }).isEmail().withMessage('Enter a valid email address')
    .isLength({ max: 255 }).withMessage('Must be 255 characters or fewer')
    .trim().toLowerCase()],
  validate,
  async (req, res, next) => {
    try {
      const { email } = req.body;

      if (!email) {
        // The shareable link: one per coach, reused. A new one is made if it expired.
        const existing = await pool.query(
          `${SELECT} WHERE i.inviter_id = $1 AND i.kind = 'link' AND i.revoked_at IS NULL`,
          [req.user.id]
        );
        const current = existing.rows[0];
        if (current && current.status !== 'expired') return res.json({ invitation: map(current) });
        if (current) await pool.query('UPDATE invitations SET revoked_at = NOW() WHERE id = $1', [current.id]);

        const { rows } = await pool.query(
          `INSERT INTO invitations (code, inviter_id, kind, expires_at)
           VALUES ($1, $2, 'link', NOW() + $3::int * interval '1 day') RETURNING id`,
          [newCode(), req.user.id, LINK_EXPIRES_DAYS]
        );
        const made = await pool.query(`${SELECT} WHERE i.id = $1`, [rows[0].id]);
        return res.status(201).json({ invitation: map(made.rows[0]) });
      }

      if (email === req.user.email) {
        return res.status(400).json(errorBody('INVITE_SELF', 'That is your own email address'));
      }
      const registered = await pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
      if (registered.rows[0]) {
        return res.status(409).json(errorBody('ALREADY_REGISTERED', 'That email address already has a Sportstures account'));
      }
      const today = await pool.query(
        `SELECT count(*)::int AS n FROM invitations
          WHERE inviter_id = $1 AND kind = 'email' AND email_sent_at > NOW() - interval '1 day'`,
        [req.user.id]
      );
      if (today.rows[0].n >= DAILY_EMAIL_LIMIT) {
        return res.status(429).json(errorBody('INVITE_LIMIT', `You can send up to ${DAILY_EMAIL_LIMIT} invitation emails a day`));
      }

      // Inviting the same address again resends the same invitation with a fresh expiry.
      const existing = await pool.query(
        `SELECT id, code FROM invitations
          WHERE inviter_id = $1 AND kind = 'email' AND lower(email) = $2 AND revoked_at IS NULL`,
        [req.user.id, email]
      );
      let id; let code; let created = false;
      if (existing.rows[0]) {
        ({ id, code } = existing.rows[0]);
        await pool.query(`UPDATE invitations SET expires_at = NOW() + $2::int * interval '1 day' WHERE id = $1`, [id, EXPIRES_DAYS]);
      } else {
        code = newCode();
        const ins = await pool.query(
          `INSERT INTO invitations (code, inviter_id, kind, email, expires_at)
           VALUES ($1, $2, 'email', $3, NOW() + $4::int * interval '1 day') RETURNING id`,
          [code, req.user.id, email, EXPIRES_DAYS]
        );
        id = ins.rows[0].id;
        created = true;
      }

      try {
        await sendCoachInvitation(email, { ...(await inviterDetails(req.user.id)), link: linkFor(code), expiresInDays: EXPIRES_DAYS });
      } catch (err) {
        console.error('Invitation email failed:', err.message);
        if (created) await pool.query('DELETE FROM invitations WHERE id = $1', [id]);
        return res.status(502).json(errorBody('EMAIL_FAILED', 'We could not send the email. Check the address and try again, or share the link instead.'));
      }
      await pool.query('UPDATE invitations SET email_sent_at = NOW() WHERE id = $1', [id]);
      const out = await pool.query(`${SELECT} WHERE i.id = $1`, [id]);
      return res.status(created ? 201 : 200).json({ invitation: map(out.rows[0]) });
    } catch (err) {
      return next(err);
    }
  }
);

// GET /api/invitations -> { invitations: [...], joined: <coaches who signed up through any of mine> }
router.get('/', authenticate, requireRole('coach', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`${SELECT} WHERE i.inviter_id = $1 AND i.revoked_at IS NULL ORDER BY i.created_at DESC`, [req.user.id]);
    const invitations = rows.map(map);
    res.json({ invitations, joined: invitations.reduce((sum, i) => sum + i.joined, 0) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/invitations/:id -> 204. The link stops working; coaches who already joined are unaffected.
router.delete(
  '/:id(\\d+)',
  authenticate,
  requireRole('coach', 'admin'),
  [param('id').isInt({ min: 1 }).toInt()],
  validate,
  async (req, res, next) => {
    try {
      const { rowCount } = await pool.query(
        'UPDATE invitations SET revoked_at = NOW() WHERE id = $1 AND inviter_id = $2 AND revoked_at IS NULL',
        [req.params.id, req.user.id]
      );
      if (!rowCount) return res.status(404).json(errorBody('INVITATION_NOT_FOUND', 'Invitation not found'));
      return res.status(204).end();
    } catch (err) {
      return next(err);
    }
  }
);

// GET /api/invitations/:code (public) -> { valid: true, inviterName, schoolName, email }
// The signup page uses it to say "Sipho from Jeppe High invited you" and to fill in the email.
router.get('/:code', lookupLimiter, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, u.first_name, u.last_name, s.name AS school
         FROM invitations i JOIN users u ON u.id = i.inviter_id
         LEFT JOIN coaches c ON c.user_id = u.id LEFT JOIN schools s ON s.id = c.school_id
        WHERE i.code = $1 AND i.revoked_at IS NULL AND i.expires_at > NOW()`,
      [String(req.params.code).slice(0, 64)]
    );
    const r = rows[0];
    if (!r) return res.status(404).json(errorBody('INVITATION_INVALID', 'This invitation link is not valid any more'));
    return res.json({
      valid: true,
      inviterName: [r.first_name, r.last_name].filter(Boolean).join(' '),
      schoolName: r.school || null,
      email: r.email,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
