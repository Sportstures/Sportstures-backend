const express = require('express');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/authController');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Slows down password guessing and mass sign-ups from one IP.
// Set AUTH_RATE_LIMIT_MAX in .env to raise it while developing (default 20 per 15 minutes).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts, try again later' } },
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many verification attempts, try again later' } },
});

const emailRule = body('email')
  .isEmail().withMessage('A valid email is required')
  .isLength({ max: 255 }).withMessage('Email is too long')
  .trim().toLowerCase();

const refreshTokenRule = body('refreshToken')
  .isString().withMessage('refreshToken is required')
  .notEmpty().withMessage('refreshToken is required');

function validateCoachSignup(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  const errors = {};
  for (const error of result.array()) {
    if (errors[error.path] === undefined) errors[error.path] = error.msg;
  }
  return res.status(422).json({ errors });
}

const coachSignupRules = [
  body('firstName').isString().trim().notEmpty().withMessage('Required')
    .isLength({ max: 100 }).withMessage('Must be 100 characters or fewer'),
  body('lastName').isString().trim().notEmpty().withMessage('Required')
    .isLength({ max: 100 }).withMessage('Must be 100 characters or fewer'),
  body('dateOfBirth').isISO8601({ strict: true, strictSeparator: true }).withMessage('Must be a real YYYY-MM-DD date')
    .custom((value) => {
      if (typeof value !== 'string') return true;
      const [year, month, day] = value.split('-').map(Number);
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
        || date.getUTCDate() !== day || date > new Date()) {
        throw new Error('Must be a real date and not in the future');
      }
      return true;
    }),
  body('gender').isIn(['male', 'female']).withMessage('Must be male or female'),
  body('school').isString().trim().notEmpty().withMessage('Required')
    .isLength({ max: 255 }).withMessage('Must be 255 characters or fewer'),
  body('coachingRole').isIn(['head_coach', 'assistant_coach', 'fitness_coach', 'team_manager'])
    .withMessage('Select a valid coaching role'),
  body('experience').isIn(['less_than_1_year', '1_3_years', '3_5_years', '5_10_years', '10_plus_years'])
    .withMessage('Select a valid experience range'),
  body('team').isObject({ strict: true }).withMessage('Required'),
  body('team.name').isString().trim().notEmpty().withMessage('Required')
    .isLength({ max: 100 }).withMessage('Must be 100 characters or fewer'),
  body('team.level').isIn(['u13', 'u14', 'u15', 'u16', 'u17', 'u19', '1st_team', '2nd_team'])
    .withMessage('Select a valid team level'),
  body('team.sport').isString().trim().notEmpty().withMessage('Required')
    .isLength({ max: 40 }).withMessage('Must be 40 characters or fewer'),
  body('email').isEmail().withMessage('Must be a valid email address')
    .isLength({ max: 255 }).withMessage('Must be 255 characters or fewer')
    .trim().toLowerCase(),
  body('password').isString().isLength({ min: 8, max: 72 })
    .withMessage('Must be between 8 and 72 characters'),
];

const isPlayer = (value, { req }) => ['player', 'learner'].includes(req.body.role);
const isNotPlayer = (value, { req }) => !['player', 'learner'].includes(req.body.role);
const hasSport = (value, { req }) => req.body.sport !== undefined && req.body.sport !== null;

const playerRegistrationRules = [
  body('role').optional().isIn(['player', 'learner']).withMessage('role must be learner'),
  body('firstName').if(isPlayer).isString().trim().notEmpty().withMessage('First name is required')
    .isLength({ max: 100 }).withMessage('First name must be 100 characters or fewer'),
  body('firstName').if(isNotPlayer).optional({ values: 'falsy' }).isString().trim().isLength({ max: 100 }),
  body('lastName').if(isPlayer).isString().trim().notEmpty().withMessage('Last name is required')
    .isLength({ max: 100 }).withMessage('Last name must be 100 characters or fewer'),
  body('lastName').if(isNotPlayer).optional({ values: 'falsy' }).isString().trim().isLength({ max: 100 }),
  body('dateOfBirth').if(isPlayer).isISO8601({ strict: true, strictSeparator: true })
    .withMessage('Date of birth must be a valid YYYY-MM-DD date')
    .custom((value) => {
      const date = new Date(value);
      const currentYear = new Date().getFullYear();
      const birthYear = Number(value.slice(0, 4));
      if (date > new Date() || birthYear < currentYear - 99 || birthYear > currentYear) {
        throw new Error('Date of birth must be within the last 99 years and not in the future');
      }
      return true;
    }),
  body('gender').if(isPlayer).isIn(['male', 'female']).withMessage('Gender must be male or female'),
  body('school').if(isPlayer).isObject({ strict: true }).withMessage('School details are required'),
  body('school.name').if(isPlayer).isString().trim().notEmpty().withMessage('School name is required')
    .isLength({ max: 255 }).withMessage('School name must be 255 characters or fewer'),
  body('school.grade').if(isPlayer).isInt({ min: 1, max: 12 }).withMessage('Grade must be between 1 and 12').toInt(),
  body('school.className').if(isPlayer).isString().trim().notEmpty().withMessage('Class name is required')
    .isLength({ max: 50 }).withMessage('Class name must be 50 characters or fewer'),
  body('sport').if(isPlayer).custom((value) => (
    value == null || (typeof value === 'object' && !Array.isArray(value))
  )).withMessage('Sport must be an object or null'),
  body('sport.name').if(hasSport).isString().trim().notEmpty()
    .withMessage('Sport name is required')
    .isLength({ max: 100 }).withMessage('Sport name must be 100 characters or fewer'),
  body('sport.teamName').if(hasSport).optional({ values: 'falsy' }).isString().trim().isLength({ max: 100 })
    .withMessage('Team name must be 100 characters or fewer'),
  body('sport.jerseyNumber').if(hasSport).customSanitizer((value) => value === '' ? null : value)
    .optional({ values: 'null' }).isInt({ min: 0, max: 999 })
    .withMessage('Jersey number must be between 0 and 999').toInt(),
  body('sport.level').if(hasSport).optional({ values: 'falsy' }).isString().trim().isLength({ max: 50 })
    .withMessage('Level must be 50 characters or fewer'),
];

router.post(
  '/register/coach',
  authLimiter,
  coachSignupRules,
  validateCoachSignup,
  controller.registerCoach
);

router.post(
  '/register',
  authLimiter,
  [
    emailRule,
    ...playerRegistrationRules,
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
  '/verify-otp',
  otpLimiter,
  [
    emailRule,
    body('code').custom((value, { req }) => {
      const submittedCode = value || req.body.otp;
      return typeof submittedCode === 'string' && /^\d{6}$/.test(submittedCode);
    }).withMessage('OTP must be a 6-digit code'),
  ],
  validate,
  controller.verifyOtp
);

router.post(
  '/resend-otp',
  otpLimiter,
  [emailRule],
  validate,
  controller.resendOtp
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
