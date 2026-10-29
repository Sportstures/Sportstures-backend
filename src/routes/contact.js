const express = require('express');
const { publicContacts } = require('../utils/contacts');

const router = express.Router();

// Public contact addresses so the website and mobile app show the right one for each purpose.
router.get('/', (req, res) => {
  res.json({ contacts: publicContacts() });
});

module.exports = router;
