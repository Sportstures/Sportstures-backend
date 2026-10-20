const express = require('express');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Slows down password guessing and mass sign-ups from one IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts, try again later' } },
});

function validate(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  res.status(400).json({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid input',
      details: result.array().map((e) => ({ field: e.path, message: e.msg })),
    },
  });
}

const emailRule = body('email')
  .isEmail().withMessage('A valid email is required')
  .isLength({ max: 255 }).withMessage('Email is too long')
  .normalizeEmail();

const refreshTokenRule = body('refreshToken')
  .isString().withMessage('refreshToken is required')
  .notEmpty().withMessage('refreshToken is required');

router.post(
  '/register',
  authLimiter,
  [
    emailRule,
    body('password')
      .isString().withMessage('Password is required')
      // bcrypt only uses the first 72 bytes, so cap the length.
      .isLength({ min: 8, max: 72 }).withMessage('Password must be 8 to 72 characters')
      .matches(/[A-Za-z]/).withMessage('Password must contain a letter')
      .matches(/[0-9]/).withMessage('Password must contain a number'),
    body('firstName').optional({ values: 'falsy' }).isString().trim().isLength({ max: 100 }),
    body('lastName').optional({ values: 'falsy' }).isString().trim().isLength({ max: 100 }),
    body('phone').optional({ values: 'falsy' }).isString().trim().isLength({ max: 20 })
      .withMessage('Phone must be 20 characters or fewer'),
  ],
  validate,
  controller.register
);

router.post(
  '/login',
  authLimiter,
  [emailRule, body('password').isString().notEmpty().withMessage('Password is required')],
  validate,
  controller.login
);

router.post('/refresh', [refreshTokenRule], validate, controller.refresh);
router.post('/logout', [refreshTokenRule], validate, controller.logout);
router.get('/me', authenticate, controller.me);

module.exports = router;
