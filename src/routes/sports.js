const express = require('express');
const pool = require('../../db/config');
const { CATEGORIES, SPORT_SELECT, mapSport } = require('../utils/sports');

const router = express.Router();

// GET /api/sports: every sport, A to Z, so the website and mobile app fill their dropdowns from one source.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`${SPORT_SELECT} ORDER BY name`);
    res.json({ sports: rows.map(mapSport) });
  } catch (err) {
    next(err);
  }
});

// GET /api/sports/categories: the sports grouped for the Favourite Sports screen, in screen order.
router.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`${SPORT_SELECT} ORDER BY sort_order NULLS LAST, name`);
    const sports = rows.map(mapSport);
    res.json({
      categories: CATEGORIES
        .map((c) => ({ ...c, sports: sports.filter((s) => s.category === c.key) }))
        .filter((c) => c.sports.length),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
