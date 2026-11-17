const rateLimit = require('express-rate-limit');

function limiter(max, message) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'TOO_MANY_REQUESTS', message } },
  });
}

// Slows down password guessing and mass sign-ups from one IP.
// Set AUTH_RATE_LIMIT_MAX in .env to raise it while developing (default 20 per 15 minutes).
const authLimiter = limiter(parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10) || 20, 'Too many attempts, try again later');

// Verification-code attempts per IP per 15 minutes (default 10). Tests raise it with OTP_RATE_LIMIT_MAX.
const otpLimiter = limiter(parseInt(process.env.OTP_RATE_LIMIT_MAX, 10) || 10, 'Too many verification attempts, try again later');

module.exports = { authLimiter, otpLimiter };
