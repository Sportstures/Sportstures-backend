const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { contactEmail } = require('./utils/contacts');
const { trustProxySetting } = require('./utils/trustProxy');

const app = express();
const PORT = process.env.PORT || 5000;

// Behind a host's proxy, req.ip must be the visitor's address, not the proxy's, or the rate limits would
// count everyone as one visitor. TRUST_PROXY sets it; on Render it is 1 automatically (see trustProxy.js).
const trustProxy = trustProxySetting();
if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic routes
app.get('/health', (req, res) => {
  res.status(200).json({ message: 'Server is running', timestamp: new Date() });
});

// Standard file that tells security researchers where to report issues (RFC 9116).
app.get('/.well-known/security.txt', (req, res) => {
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  res.type('text/plain').send(`Contact: mailto:${contactEmail('security')}\nExpires: ${expires}\nPreferred-Languages: en\n`);
});

app.use('/api/contact', require('./routes/contact'));
app.use('/api/support', require('./routes/support'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/sports', require('./routes/sports'));
app.use('/api/schools', require('./routes/schools'));
app.use('/api/competitions', require('./routes/competitions'));
app.use('/api/teams', require('./routes/teams'));
app.use('/api/fixtures', require('./routes/fixtures'));
app.use('/api/fixtures', require('./routes/lineups'));
app.use('/api/fixtures', require('./routes/liveScoring'));
app.use('/api/results', require('./routes/results'));
app.use('/api/rankings', require('./routes/rankings'));
app.use('/api/teams', require('./routes/roster'));
app.use('/api/me/favorites', require('./routes/favorites'));
app.use('/api/me/notifications', require('./routes/notifications'));
app.use('/api/me', require('./routes/account'));
app.use('/api/me', require('./routes/me'));
app.use('/api/coach', require('./routes/coach'));
app.use('/api/invitations', require('./routes/invitations'));
app.use('/api/match-invitations', require('./routes/matchInvitations'));

// Routes placeholder (to be implemented)
// app.use('/api/users', require('./routes/users'));
// app.use('/api/coaches', require('./routes/coaches'));
// app.use('/api/teams', require('./routes/teams'));
// app.use('/api/fixtures', require('./routes/fixtures'));
// app.use('/api/scores', require('./routes/scores'));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!', message: err.message });
});

// Only start listening when run directly (npm start / npm run dev), so tests can import the app.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
}

module.exports = app;
