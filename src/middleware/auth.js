const pool = require('../../db/config');
const { verifyAccessToken } = require('../utils/tokens');

// Protects a route. Expects "Authorization: Bearer <accessToken>".
// On success, sets req.user = { id, email, role, ... } (never includes the password).
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({
      error: { code: 'NO_TOKEN', message: 'Authentication required' },
    });
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: {
        code: expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        message: expired ? 'Access token expired' : 'Invalid access token',
      },
    });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, email, first_name, last_name, phone, role FROM users WHERE id = $1',
      [payload.sub]
    );
    if (rows.length === 0) {
      return res.status(401).json({
        error: { code: 'INVALID_TOKEN', message: 'User no longer exists' },
      });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

// Use after authenticate: router.post('/', authenticate, requireRole('admin', 'coach'), handler)
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'You do not have permission to do this' },
      });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
