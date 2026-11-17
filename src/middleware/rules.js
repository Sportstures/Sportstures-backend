// express-validator rules shared by signup and the account-change endpoints, so both check the same way.
const { body } = require('express-validator');

// bcrypt only uses the first 72 bytes, so the length is capped.
function passwordRule(field) {
  return body(field)
    .isString().withMessage('Password is required')
    .isLength({ min: 8, max: 72 }).withMessage('Password must be 8 to 72 characters')
    .matches(/[A-Za-z]/).withMessage('Password must contain a letter')
    .matches(/[0-9]/).withMessage('Password must contain a number');
}

function emailRule(field) {
  return body(field)
    .isEmail().withMessage('A valid email is required')
    .isLength({ max: 255 }).withMessage('Email is too long')
    .trim().toLowerCase();
}

function codeRule(field = 'code') {
  return body(field).custom((value) => typeof value === 'string' && /^\d{6}$/.test(value))
    .withMessage('The code must be 6 digits');
}

// A real YYYY-MM-DD date in the last 99 years and not in the future.
function isValidBirthDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const thisYear = new Date().getUTCFullYear();
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date <= new Date() && year >= thisYear - 99;
}

module.exports = { passwordRule, emailRule, codeRule, isValidBirthDate };
