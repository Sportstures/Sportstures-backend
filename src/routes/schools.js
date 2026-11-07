// Schools. Reading is public (the website lists schools by province); editing a school's
// location is limited to admins and the coach of a team at that school.
const express = require('express');
const { body, query, param } = require('express-validator');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { authenticate, requireRole } = require('../middleware/auth');
const { errorBody } = require('../utils/serializers');
const { PROVINCES } = require('../utils/schools');

const router = express.Router();

const idParam = param('id').isInt({ min: 1 }).withMessage('id must be a number').toInt();

const SELECT = `SELECT s.id, s.name, s.province, s.town,
    (SELECT count(*)::int FROM teams t WHERE t.school_id = s.id) AS team_count,
    COALESCE((SELECT array_agg(DISTINCT sp.name ORDER BY sp.name)
                FROM teams t JOIN sports sp ON sp.id = t.sport_id
               WHERE t.school_id = s.id), ARRAY[]::text[]) AS sports
  FROM schools s`;

function mapSchool(r) {
  return {
    id: r.id,
    name: r.name,
    province: r.province,
    town: r.town,
    teamCount: r.team_count,
    sports: r.sports,
  };
}

// GET /api/schools?province=&q=&limit=&offset=  (public)
router.get(
  '/',
  [
    query('province').optional().isIn(PROVINCES).withMessage('province must be one of the 9 provinces'),
    query('q').optional().isString().trim().isLength({ max: 100 }),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { province, q } = req.query;
      const limit = req.query.limit || 50;
      const offset = req.query.offset || 0;
      const where = [];
      const params = [];
      if (province) { params.push(province); where.push(`s.province = $${params.length}`); }
      if (q) { params.push(`%${q}%`); where.push(`s.name ILIKE $${params.length}`); }
      params.push(limit, offset);
      const { rows } = await pool.query(
        `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY s.name LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      res.json({ schools: rows.map(mapSchool), limit, offset });
    } catch (err) {
      next(err);
    }
  }
);

async function loadSchool(id) {
  const { rows } = await pool.query(`${SELECT} WHERE s.id = $1`, [id]);
  return rows[0];
}

// GET /api/schools/:id  (public)
router.get('/:id', [idParam], validate, async (req, res, next) => {
  try {
    const school = await loadSchool(req.params.id);
    if (!school) return res.status(404).json(errorBody('NOT_FOUND', 'School not found'));
    res.json({ school: mapSchool(school) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/schools/:id: set the province and town. Admins, or a coach with a team at the school.
router.patch(
  '/:id',
  authenticate,
  requireRole('coach', 'admin'),
  [
    idParam,
    body('province').optional({ values: 'null' }).isIn(PROVINCES).withMessage('province must be one of the 9 provinces'),
    body('town').optional({ values: 'null' }).isString().trim().isLength({ max: 100 })
      .withMessage('town must be 100 characters or fewer'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const school = await loadSchool(req.params.id);
      if (!school) return res.status(404).json(errorBody('NOT_FOUND', 'School not found'));

      if (req.user.role === 'coach') {
        const link = await pool.query('SELECT 1 FROM teams WHERE school_id = $1 AND coach_id = $2', [school.id, req.user.id]);
        if (!link.rows[0]) {
          return res.status(403).json(errorBody('FORBIDDEN', "You can only edit your own school's details"));
        }
      }

      const sets = [];
      const params = [];
      const set = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
      if (req.body.province !== undefined) set('province', req.body.province);
      if (req.body.town !== undefined) set('town', req.body.town || null);
      if (sets.length) {
        params.push(school.id);
        await pool.query(`UPDATE schools SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }
      res.json({ school: mapSchool(await loadSchool(school.id)) });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
