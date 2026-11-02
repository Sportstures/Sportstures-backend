const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { contactEmail } = require('./utils/contacts');

const app = express();
const PORT = process.env.PORT || 5000;

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
app.use('/api/auth', require('./routes/auth'));
app.use('/api/sports', require('./routes/sports'));
app.use('/api/competitions', require('./routes/competitions'));
app.use('/api/teams', require('./routes/teams'));
app.use('/api/fixtures', require('./routes/fixtures'));

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
