const { validationResult } = require('express-validator');

// Runs after express-validator rules and answers with the standard VALIDATION_ERROR shape.
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

module.exports = validate;
