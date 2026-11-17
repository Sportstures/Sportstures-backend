// Account changes after signup (mounted at /api/me): profile details, password and email.
// Forgot/reset password live in routes/auth.js, since the user is not logged in then.
const express = require('express');
const { body } = require('express-validator');
const controller = require('../controllers/accountController');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { authLimiter, otpLimiter } = require('../middleware/rateLimits');
const { passwordRule, emailRule, codeRule, isValidBirthDate } = require('../middleware/rules');
const { PROVINCES } = require('../utils/schools');

const router = express.Router();

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sportIsObject = (value, { req }) => isObject(req.body.sport);
const schoolHasName = (value, { req }) => isObject(req.body.school) && req.body.school.name !== undefined;

// Every field is optional; a field that is sent must be valid. Text fields are trimmed.
const profileRules = [
  body('firstName').optional().isString().trim().notEmpty().withMessage('First name cannot be empty')
    .isLength({ max: 100 }).withMessage('First name must be 100 characters or fewer'),
  body('lastName').optional().isString().trim().notEmpty().withMessage('Last name cannot be empty')
    .isLength({ max: 100 }).withMessage('Last name must be 100 characters or fewer'),
  body('phone').optional({ values: 'null' }).isString().withMessage('Phone must be text').trim()
    .matches(/^[+0-9 ()-]{0,20}$/).withMessage('Phone may only use digits, spaces, +, - and brackets (20 at most)'),
  body('dateOfBirth').optional().custom(isValidBirthDate)
    .withMessage('Date of birth must be a real YYYY-MM-DD date within the last 99 years, not in the future'),
  body('gender').optional().isIn(['male', 'female']).withMessage('Gender must be male or female'),

  body('school').optional().custom(isObject).withMessage('School must be an object'),
  body('school.name').optional().isString().trim().notEmpty().withMessage('School name cannot be empty')
    .isLength({ max: 255 }).withMessage('School name must be 255 characters or fewer'),
  body('school.province').optional({ values: 'falsy' }).isIn(PROVINCES).withMessage('Province must be one of the 9 provinces')
    .custom(schoolHasName).withMessage('Send school.name with the province'),
  body('school.town').optional({ values: 'falsy' }).isString().trim().isLength({ max: 100 })
    .withMessage('Town must be 100 characters or fewer')
    .custom(schoolHasName).withMessage('Send school.name with the town'),
  body('school.grade').optional().isInt({ min: 1, max: 12 }).withMessage('Grade must be between 1 and 12').toInt(),
  body('school.className').optional().isString().trim().notEmpty().withMessage('Class name cannot be empty')
    .isLength({ max: 50 }).withMessage('Class name must be 50 characters or fewer'),

  body('sport').optional({ values: 'null' }).custom(isObject).withMessage('Sport must be an object, or null for no sport'),
  body('sport.name').if(sportIsObject).optional().isString().trim().notEmpty().withMessage('Sport name cannot be empty')
    .isLength({ max: 100 }).withMessage('Sport name must be 100 characters or fewer'),
  body('sport.teamName').if(sportIsObject).optional({ values: 'null' }).isString().trim().isLength({ max: 100 })
    .withMessage('Team name must be 100 characters or fewer'),
  body('sport.jerseyNumber').if(sportIsObject).customSanitizer((value) => (value === '' ? null : value))
    .optional({ values: 'null' }).isInt({ min: 0, max: 999 }).withMessage('Jersey number must be between 0 and 999').toInt(),
  body('sport.level').if(sportIsObject).optional({ values: 'null' }).isString().trim().isLength({ max: 50 })
    .withMessage('Level must be 50 characters or fewer'),
];

router.patch('/profile', authenticate, profileRules, validate, controller.updateProfile);

router.put(
  '/password',
  authLimiter,
  authenticate,
  [body('currentPassword').isString().notEmpty().withMessage('Current password is required'), passwordRule('newPassword')],
  validate,
  controller.changePassword
);

router.post(
  '/email',
  authLimiter,
  authenticate,
  [emailRule('newEmail'), body('password').isString().notEmpty().withMessage('Password is required')],
  validate,
  controller.requestEmailChange
);

router.post('/email/verify', otpLimiter, authenticate, [codeRule()], validate, controller.confirmEmailChange);

module.exports = router;
