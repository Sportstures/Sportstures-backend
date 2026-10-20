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

    // Signup step 1. dateOfBirth is "YYYY-MM-DD" (the app converts its day/month/year dropdowns).
    body('dateOfBirth').optional({ values: 'falsy' })
      .isISO8601({ strict: true, strictSeparator: true }).withMessage('dateOfBirth must be YYYY-MM-DD')
      .custom((value) => {
        const date = new Date(value);
        if (date > new Date()) throw new Error('dateOfBirth cannot be in the future');
        if (date.getUTCFullYear() < 1900) throw new Error('dateOfBirth is too far in the past');
        return true;
      }),
    body('gender').optional({ values: 'falsy' }).isString().trim().toLowerCase()
      .isIn(['male', 'female']).withMessage('gender must be male or female'),
    // Admins are never self-registered: only learner or coach can be chosen.
    body('role').optional({ values: 'falsy' }).isIn(['learner', 'coach'])
      .withMessage('role must be learner or coach'),

    // Signup step 2
    body('school').optional({ values: 'null' }).isObject().withMessage('school must be an object'),
    body('school.name').optional({ values: 'falsy' }).isString().trim().isLength({ min: 1, max: 255 })
      .withMessage('school.name must be 1 to 255 characters'),
    body('school.grade').optional({ values: 'null' }).isInt({ min: 1, max: 12 })
      .withMessage('school.grade must be a number from 1 to 12').toInt(),
    body('school.className').optional({ values: 'falsy' }).isString().trim().isLength({ max: 50 })
      .withMessage('school.className must be 50 characters or fewer'),

    // Signup step 3 (can be skipped)
    body('sport').optional({ values: 'null' }).isObject().withMessage('sport must be an object'),
    body('sport.name').optional({ values: 'falsy' }).isString().trim().isLength({ max: 100 }),
    body('sport.teamName').optional({ values: 'falsy' }).isString().trim().isLength({ max: 100 })
      .withMessage('sport.teamName must be 100 characters or fewer'),
    body('sport.jerseyNumber').optional({ values: 'null' }).isInt({ min: 0, max: 999 })
      .withMessage('sport.jerseyNumber must be a number from 0 to 999').toInt(),
    body('sport.level').optional({ values: 'falsy' }).isString().trim().isLength({ max: 50 })
      .withMessage('sport.level must be 50 characters or fewer'),

    // Coach details (only used when role is coach)
    body('coach').optional({ values: 'null' }).isObject().withMessage('coach must be an object'),
    body('coach.specialization').optional({ values: 'falsy' }).isString().trim().isLength({ max: 100 }),
    body('coach.yearsOfExperience').optional({ values: 'null' }).isInt({ min: 0, max: 80 }).toInt(),
    body('coach.certification').optional({ values: 'falsy' }).isString().trim().isLength({ max: 255 }),
    body('coach.bio').optional({ values: 'falsy' }).isString().trim().isLength({ max: 2000 }),
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
