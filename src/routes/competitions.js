const express = require('express');
const { body, query } = require('express-validator');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { authenticate, requireRole } = require('../middleware/auth');
const { errorBody } = require('../utils/serializers');

const router = express.Router();

const SELECT = `SELECT c.id, c.name, c.season, sp.id AS sport_id, sp.name AS sport_name
  FROM competitions c LEFT JOIN sports sp ON sp.id = c.sport_id`;

function mapCompetition(r) {
  return {
    id: r.id,
    name: r.name,
    season: r.season,
    sport: r.sport_id ? { id: r.sport_id, name: r.sport_name } : null,
  };
}

// GET /api/competitions?sportId=3
router.get(
  '/',
  authenticate,
  [query('sportId').optional().isInt({ min: 1 }).toInt()],
  validate,
  async (req, res, next) => {
    try {
      const params = [];
      let where = '';
      if (req.query.sportId) {
        params.push(req.query.sportId);
        where = 'WHERE c.sport_id = $1';
      }
      const { rows } = await pool.query(`${SELECT} ${where} ORDER BY c.name`, params);
      res.json({ competitions: rows.map(mapCompetition) });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/competitions (coach or admin)
router.post(
  '/',
  authenticate,
  requireRole('coach', 'admin'),
  [
    body('name').isString().trim().isLength({ min: 1, max: 255 }).withMessage('name is required (max 255 characters)'),
    body('sportId').optional({ values: 'null' }).isInt({ min: 1 }).toInt(),
    body('season').optional({ values: 'falsy' }).isString().trim().isLength({ max: 20 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { name, sportId, season } = req.body;
      if (sportId) {
        const sport = await pool.query('SELECT 1 FROM sports WHERE id = $1', [sportId]);
        if (!sport.rows[0]) return res.status(400).json(errorBody('UNKNOWN_SPORT', 'Unknown sportId'));
      }
      const inserted = await pool.query(
        'INSERT INTO competitions (name, sport_id, season, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
        [name, sportId || null, season || null, req.user.id]
      );
      const { rows } = await pool.query(`${SELECT} WHERE c.id = $1`, [inserted.rows[0].id]);
      res.status(201).json({ competition: mapCompetition(rows[0]) });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json(errorBody('COMPETITION_EXISTS', 'A competition with this name already exists'));
      }
      next(err);
    }
  }
);

module.exports = router;
