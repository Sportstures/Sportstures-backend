const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
const REFRESH_EXPIRES_DAYS = parseInt(process.env.JWT_REFRESH_EXPIRES_DAYS, 10) || 30;

function requireSecret(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Add it to your .env file.`);
  }
  return value;
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role },
    requireSecret('JWT_SECRET'),
    { expiresIn: ACCESS_EXPIRES_IN }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, requireSecret('JWT_SECRET'));
}

// Refresh tokens are random opaque strings. Only a SHA-256 hash is stored in the DB.
function generateRefreshToken() {
  const token = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
  return { token, tokenHash: hashToken(token), expiresAt };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashToken,
};
