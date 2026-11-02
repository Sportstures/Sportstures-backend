const express = require('express');
const { body, query, param } = require('express-validator');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { authenticate, requireRole } = require('../middleware/auth');
const { errorBody, teamSelect, teamJoins, mapTeam } = require('../utils/serializers');
const { findOrCreateSchool } = require('../utils/schools');
const { teamRecord } = require('../utils/standings');

const router = express.Router();

const TEAM_SELECT = `SELECT ${teamSelect('t', 't')},
    t.description, t.location, t.founded_year, t.coach_id,
    cu.id AS coach_user_id, cu.first_name AS coach_first_name, cu.last_name AS coach_last_name,
    (SELECT count(*)::int FROM team_members tm WHERE tm.team_id = t.id AND tm.status = 'active') AS player_count
  FROM teams t
  ${teamJoins('t', 't')}
  LEFT JOIN users cu ON cu.id = t.coach_id`;

function mapFullTeam(r) {
  return {
    ...mapTeam(r, 't'),
    description: r.description,
    location: r.location,
    foundedYear: r.founded_year,
    playerCount: r.player_count,
    coach: r.coach_user_id
      ? { id: r.coach_user_id, name: [r.coach_first_name, r.coach_last_name].filter(Boolean).join(' ') || null }
      : null,
  };
}

async function loadTeam(id) {
  const { rows } = await pool.query(`${TEAM_SELECT} WHERE t.id = $1`, [id]);
  return rows[0];
}

// Admins can manage any team; a coach can only manage teams assigned to them.
function canManage(user, teamRow) {
  return user.role === 'admin' || (user.role === 'coach' && teamRow.coach_user_id === user.id);
}

const idParam = param('id').isInt({ min: 1 }).withMessage('id must be a number').toInt();

const teamFields = [
  body('sportId').optional({ values: 'null' }).isInt({ min: 1 }).withMessage('sportId must be a number').toInt(),
  body('school').optional({ values: 'falsy' }).isString().trim().isLength({ min: 1, max: 255 }),
  body('level').optional({ values: 'falsy' }).isString().trim().isLength({ max: 50 }),
  body('genderCategory').optional({ values: 'falsy' }).isString().trim().toLowerCase()
    .isIn(['boys', 'girls', 'mixed']).withMessage('genderCategory must be boys, girls or mixed'),
  body('description').optional({ values: 'falsy' }).isString().trim().isLength({ max: 2000 }),
  body('location').optional({ values: 'falsy' }).isString().trim().isLength({ max: 255 }),
  body('foundedYear').optional({ values: 'null' }).isInt({ min: 1800, max: 2100 }).toInt(),
];

// GET /api/teams?sportId=&schoolId=&q=&mine=true&limit=&offset=
router.get(
  '/',
  authenticate,
  [
    query('sportId').optional().isInt({ min: 1 }).toInt(),
    query('schoolId').optional().isInt({ min: 1 }).toInt(),
    query('mine').optional().isBoolean().toBoolean(),
    query('q').optional().isString().trim().isLength({ max: 100 }),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { sportId, schoolId, mine, q } = req.query;
      const limit = req.query.limit || 50;
      const offset = req.query.offset || 0;
      const where = [];
      const params = [];
      const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

      if (sportId) add('t.sport_id = ?', sportId);
      if (schoolId) add('t.school_id = ?', schoolId);
      if (q) add('t.name ILIKE ?', `%${q}%`);
      if (mine) add('cu.id = ?', req.user.id); // teams coached by the logged-in user

      params.push(limit, offset);
      const { rows } = await pool.query(
        `${TEAM_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY t.name LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      res.json({ teams: rows.map(mapFullTeam), limit, offset });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:id', authenticate, [idParam], validate, async (req, res, next) => {
  try {
    const team = await loadTeam(req.params.id);
    if (!team) return res.status(404).json(errorBody('NOT_FOUND', 'Team not found'));
    res.json({ team: mapFullTeam(team) });
  } catch (err) {
    next(err);
  }
});

// POST /api/teams (coach or admin). A coach's new team is assigned to that coach.
router.post(
  '/',
  authenticate,
  requireRole('coach', 'admin'),
  [body('name').isString().trim().isLength({ min: 1, max: 255 }).withMessage('name is required (max 255 characters)'),
    ...teamFields],
  validate,
  async (req, res, next) => {
    try {
      const { name, sportId, school, level, genderCategory, description, location, foundedYear } = req.body;

      if (sportId) {
        const sport = await pool.query('SELECT 1 FROM sports WHERE id = $1', [sportId]);
        if (!sport.rows[0]) return res.status(400).json(errorBody('UNKNOWN_SPORT', 'Unknown sportId'));
      }

      let coachId = null;
      let schoolId = school ? await findOrCreateSchool(pool, school) : null;
      if (req.user.role === 'coach') {
        const coach = await pool.query('SELECT school_id FROM coaches WHERE user_id = $1', [req.user.id]);
        if (!coach.rows[0]) {
          return res.status(409).json(errorBody('COACH_PROFILE_MISSING', 'Coach profile is not configured'));
        }
        coachId = req.user.id;
        const existingTeam = await pool.query('SELECT 1 FROM teams WHERE coach_id = $1', [coachId]);
        if (existingTeam.rows[0]) {
          return res.status(409).json(errorBody('COACH_TEAM_EXISTS', 'A coach can only have one team'));
        }
        // Default to the coach's own school when none is given.
        if (!schoolId) schoolId = coach.rows[0].school_id || null;
      }

      try {
        const inserted = await pool.query(
          `INSERT INTO teams (name, coach_id, school_id, sport_id, level, gender_category,
                              description, location, founded_year)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [name, coachId, schoolId, sportId || null, level || null, genderCategory || null,
            description || null, location || null, foundedYear ?? null]
        );
        res.status(201).json({ team: mapFullTeam(await loadTeam(inserted.rows[0].id)) });
      } catch (err) {
        if (err.code === '23505' && coachId) {
          return res.status(409).json(errorBody('COACH_TEAM_EXISTS', 'A coach can only have one team'));
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/teams/:id (the team's coach or an admin). Only the fields sent are changed.
router.patch(
  '/:id',
  authenticate,
  requireRole('coach', 'admin'),
  [idParam,
    body('name').optional().isString().trim().isLength({ min: 1, max: 255 }).withMessage('name must be 1 to 255 characters'),
    ...teamFields],
  validate,
  async (req, res, next) => {
    try {
      const team = await loadTeam(req.params.id);
      if (!team) return res.status(404).json(errorBody('NOT_FOUND', 'Team not found'));
      if (!canManage(req.user, team)) {
        return res.status(403).json(errorBody('FORBIDDEN', 'You can only edit your own teams'));
      }

      const b = req.body;
      if (b.sportId) {
        const sport = await pool.query('SELECT 1 FROM sports WHERE id = $1', [b.sportId]);
        if (!sport.rows[0]) return res.status(400).json(errorBody('UNKNOWN_SPORT', 'Unknown sportId'));
      }

      const sets = [];
      const params = [];
      const set = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };

      if (b.name !== undefined) set('name', b.name);
      if (b.sportId !== undefined) set('sport_id', b.sportId || null);
      if (b.school !== undefined) set('school_id', b.school ? await findOrCreateSchool(pool, b.school) : null);
      if (b.level !== undefined) set('level', b.level || null);
      if (b.genderCategory !== undefined) set('gender_category', b.genderCategory || null);
      if (b.description !== undefined) set('description', b.description || null);
      if (b.location !== undefined) set('location', b.location || null);
      if (b.foundedYear !== undefined) set('founded_year', b.foundedYear ?? null);

      if (sets.length) {
        sets.push('updated_at = CURRENT_TIMESTAMP');
        params.push(req.params.id);
        await pool.query(`UPDATE teams SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }
      res.json({ team: mapFullTeam(await loadTeam(req.params.id)) });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/teams/:id/record?competitionId=: win/loss record, win rate, averages and recent form,
// worked out from the team's finished fixtures. Feeds the season summary and the coach dashboard.
router.get(
  '/:id/record',
  authenticate,
  [idParam, query('competitionId').optional().isInt({ min: 1 }).toInt()],
  validate,
  async (req, res, next) => {
    try {
      const team = await loadTeam(req.params.id);
      if (!team) return res.status(404).json(errorBody('NOT_FOUND', 'Team not found'));

      const params = [req.params.id];
      let competitionFilter = '';
      if (req.query.competitionId) {
        params.push(req.query.competitionId);
        competitionFilter = 'AND f.competition_id = $2';
      }
      const finished = await pool.query(
        `SELECT f.home_team_id, f.away_team_id, sc.home_team_score, sc.away_team_score
           FROM fixtures f JOIN scores sc ON sc.fixture_id = f.id
          WHERE f.status = 'finished' AND (f.home_team_id = $1 OR f.away_team_id = $1) ${competitionFilter}
          ORDER BY f.match_date, f.id`,
        params
      );
      const record = teamRecord(req.params.id, finished.rows.map((r) => ({
        homeTeamId: r.home_team_id,
        awayTeamId: r.away_team_id,
        homeScore: r.home_team_score,
        awayScore: r.away_team_score,
      })));
      res.json({ team: mapFullTeam(team), record });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
