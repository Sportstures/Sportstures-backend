const express = require('express');
const pool = require('../../db/config');

const router = express.Router();

// Public list of sports so the website and mobile app fill their dropdowns from one source.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM sports ORDER BY name');
    res.json({ sports: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
