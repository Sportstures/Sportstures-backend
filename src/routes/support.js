// Help & Support: messages from the apps' Help & Support screen, emailed to the support mailbox.
const express = require('express');
const { body } = require('express-validator');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { optionalAuthenticate } = require('../middleware/auth');
const { canSendEmail, sendSupportMessage, sendSupportReceipt } = require('../utils/email');
const { errorBody } = require('../utils/serializers');

const router = express.Router();

const TOPICS = ['account', 'matches', 'teams', 'other'];
const DEFAULT_SUBJECTS = {
  account: 'Help with my account',
  matches: 'Help with matches',
  teams: 'Help with teams',
  other: 'Help request',
};

// Messages per signed-in user, or per IP when signed out, per hour (default 5). Only messages that are
// accepted count, so fixing a validation error does not use one up.
const supportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: parseInt(process.env.SUPPORT_RATE_LIMIT_MAX, 10) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`),
  message: errorBody('TOO_MANY_REQUESTS', 'You have sent several messages recently. Please try again later'),
});

const signedOut = (value, { req }) => !req.user;
const oneLine = (value) => (typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ') : value);

const rules = [
  body('topic').isIn(TOPICS).withMessage('Choose a topic'),
  body('subject').optional({ values: 'falsy' }).isString().withMessage('Subject must be text')
    .customSanitizer(oneLine).trim().isLength({ max: 150 }).withMessage('Subject must be 150 characters or fewer'),
  body('message').isString().withMessage('Message is required').trim()
    .isLength({ min: 10, max: 5000 }).withMessage('Message must be 10 to 5000 characters'),
  // Signed in, the account's email and name are used instead, so these are only checked when signed out.
  body('email').if(signedOut).trim().isEmail().withMessage('Enter the email address we should reply to')
    .isLength({ max: 255 }).withMessage('Email is too long').toLowerCase(),
  body('name').if(signedOut).optional({ values: 'falsy' }).isString().withMessage('Name must be text')
    .customSanitizer(oneLine).trim().isLength({ max: 100 }).withMessage('Name must be 100 characters or fewer'),
  body('app').optional({ values: 'null' })
    .custom((value) => typeof value === 'object' && !Array.isArray(value)).withMessage('app must be an object'),
  body('app.platform').optional({ values: 'falsy' }).isIn(['android', 'ios', 'web'])
    .withMessage('Platform must be android, ios or web'),
  body('app.version').optional({ values: 'falsy' }).isString().trim().isLength({ max: 20 })
    .withMessage('Version must be 20 characters or fewer'),
];

// The signed-in user's school, for support's context.
async function schoolOf(user) {
  const table = user.role === 'coach' ? 'coaches' : 'learner_profiles';
  const { rows: [row] } = await pool.query(
    `SELECT s.name FROM ${table} p JOIN schools s ON s.id = p.school_id WHERE p.user_id = $1`,
    [user.id]
  );
  return row ? row.name : null;
}

// POST /api/support/messages: send a message to support. Login optional.
router.post('/messages', optionalAuthenticate, supportLimiter, rules, validate, async (req, res, next) => {
  try {
    if (!canSendEmail()) {
      return res.status(503).json(errorBody('SUPPORT_UNAVAILABLE', 'Messages cannot be sent right now. Please email us instead'));
    }

    const { topic, message } = req.body;
    const subject = req.body.subject || DEFAULT_SUBJECTS[topic];
    const app = req.body.app || {};
    const platform = app.platform || null;
    const version = app.version || null;

    let email = req.body.email;
    let name = req.body.name || null;
    let user = null;
    if (req.user) {
      email = req.user.email;
      name = [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || null;
      user = { id: req.user.id, role: req.user.role, school: await schoolOf(req.user) };
    }

    const { rows: [saved] } = await pool.query(
      `INSERT INTO support_messages (user_id, email, name, topic, subject, message, platform, app_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [user ? user.id : null, email, name, topic, subject, message, platform, version]
    );
    const details = { id: saved.id, topic, subject, message, email, name, user, app: { platform, version } };

    // The message is saved either way; a failed email is logged and left with emailed_at NULL.
    try {
      await sendSupportMessage(details);
      await pool.query('UPDATE support_messages SET emailed_at = CURRENT_TIMESTAMP WHERE id = $1', [saved.id]);
    } catch (err) {
      console.error(`Support message #${saved.id} was saved but not emailed:`, err.message);
    }
    sendSupportReceipt(details).catch((err) => console.error(`Support receipt #${saved.id} failed:`, err.message));

    res.status(201).json({ id: saved.id, replyTo: email, message: `Thanks. We'll reply to ${email}.` });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
