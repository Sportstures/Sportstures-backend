const express = require('express');
const { body, query, param } = require('express-validator');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { authenticate, requireRole } = require('../middleware/auth');
const { errorBody, FIXTURE_SELECT, FIXTURE_FROM, mapFixture } = require('../utils/serializers');

const router = express.Router();

const MATCH_TYPES = ['league', 'semifinal', 'championship', 'friendly'];
// Coaches can only schedule, postpone or cancel. 'live' and 'finished' come from match scoring.
const EDITABLE_STATUSES = ['scheduled', 'postponed', 'cancelled'];

const idParam = param('id').isInt({ min: 1 }).withMessage('id must be a number').toInt();

async function loadFixture(id) {
  const { rows } = await pool.query(`SELECT ${FIXTURE_SELECT} ${FIXTURE_FROM} WHERE f.id = $1`, [id]);
  return rows[0];
}

// Admins can manage any fixture; a coach can manage fixtures for their own (home) team.
function canManage(user, row) {
  return user.role === 'admin' || (user.role === 'coach' && row.h_coach_user_id === user.id);
}

async function checkReferences({ competitionId }) {
  if (competitionId) {
    const comp = await pool.query('SELECT 1 FROM competitions WHERE id = $1', [competitionId]);
    if (!comp.rows[0]) return errorBody('UNKNOWN_COMPETITION', 'Unknown competitionId');
  }
  return null;
}

// GET /api/fixtures
//   teamId, sportId, competitionId, status, from, to (ISO dates), mine=true (teams I coach),
//   when=upcoming|past, order=asc|desc, limit, offset
router.get(
  '/',
  authenticate,
  [
    query('teamId').optional().isInt({ min: 1 }).toInt(),
    query('sportId').optional().isInt({ min: 1 }).toInt(),
    query('competitionId').optional().isInt({ min: 1 }).toInt(),
    query('status').optional().isIn(['scheduled', 'live', 'finished', 'cancelled', 'postponed']),
    query('when').optional().isIn(['upcoming', 'past']),
    query('from').optional().isISO8601(),
    query('to').optional().isISO8601(),
    query('mine').optional().isBoolean().toBoolean(),
    query('order').optional().isIn(['asc', 'desc']),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { teamId, sportId, competitionId, status, when, from, to, mine } = req.query;
      const limit = req.query.limit || 50;
      const offset = req.query.offset || 0;
      const where = [];
      const params = [];
      const add = (sql, value) => { params.push(value); where.push(sql.replace(/\?/g, `$${params.length}`)); };

      if (teamId) add('(f.home_team_id = ? OR f.away_team_id = ?)', teamId);
      if (sportId) add('(hmt.sport_id = ? OR amt.sport_id = ?)', sportId);
      if (competitionId) add('f.competition_id = ?', competitionId);
      if (status) add('f.status = ?', status);
      if (from) add('f.match_date >= ?', from);
      if (to) add('f.match_date <= ?', to);
      if (mine) add('(hcu.id = ? OR acu.id = ?)', req.user.id);
      // upcoming = still to be played; past = played (has a final score)
      if (when === 'upcoming') where.push("f.status IN ('scheduled', 'live', 'postponed')");
      if (when === 'past') where.push("f.status = 'finished'");

      // Past fixtures read best newest-first, upcoming ones soonest-first.
      const order = (req.query.order || (when === 'past' ? 'desc' : 'asc')) === 'desc' ? 'DESC' : 'ASC';

      params.push(limit, offset);
      const { rows } = await pool.query(
        `SELECT ${FIXTURE_SELECT} ${FIXTURE_FROM}
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY f.match_date ${order}, f.id ${order}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      res.json({ fixtures: rows.map(mapFixture), limit, offset });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:id', authenticate, [idParam], validate, async (req, res, next) => {
  try {
    const row = await loadFixture(req.params.id);
    if (!row) return res.status(404).json(errorBody('NOT_FOUND', 'Fixture not found'));
    res.json({ fixture: mapFixture(row) });
  } catch (err) {
    next(err);
  }
});

// POST /api/fixtures: the coach of the home team (or an admin) schedules a fixture.
router.post(
  '/',
  authenticate,
  requireRole('coach', 'admin'),
  [
    body('homeTeamId').isInt({ min: 1 }).withMessage('homeTeamId is required').toInt(),
    body('awayTeamId').isInt({ min: 1 }).withMessage('awayTeamId is required').toInt(),
    // Must include a time zone, e.g. 2026-11-06T18:00:00+02:00, so the time is unambiguous.
    body('matchDate').isISO8601({ strict: true }).withMessage('matchDate must be an ISO 8601 date-time')
      .matches(/(Z|[+-]\d{2}:?\d{2})$/).withMessage('matchDate must include a time zone, e.g. 2026-11-06T18:00:00+02:00'),
    body('venue').optional({ values: 'falsy' }).isString().trim().isLength({ max: 255 }),
    body('competitionId').optional({ values: 'null' }).isInt({ min: 1 }).toInt(),
    body('matchType').optional().isIn(MATCH_TYPES).withMessage(`matchType must be one of: ${MATCH_TYPES.join(', ')}`),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { homeTeamId, awayTeamId, matchDate, venue, competitionId, matchType } = req.body;

      if (homeTeamId === awayTeamId) {
        return res.status(400).json(errorBody('SAME_TEAM', 'A team cannot play itself'));
      }

      const teams = await pool.query(
        `SELECT t.id, t.sport_id, cu.id AS coach_user_id
           FROM teams t
           LEFT JOIN coaches co ON co.id = t.coach_id
           LEFT JOIN users cu ON cu.id = co.user_id
          WHERE t.id IN ($1, $2)`,
        [homeTeamId, awayTeamId]
      );
      const home = teams.rows.find((t) => t.id === homeTeamId);
      const away = teams.rows.find((t) => t.id === awayTeamId);
      if (!home || !away) return res.status(404).json(errorBody('NOT_FOUND', 'Home or away team not found'));

      if (req.user.role !== 'admin' && home.coach_user_id !== req.user.id) {
        return res.status(403).json(errorBody('FORBIDDEN', 'You can only schedule fixtures for a team you coach'));
      }
      if (home.sport_id && away.sport_id && home.sport_id !== away.sport_id) {
        return res.status(400).json(errorBody('SPORT_MISMATCH', 'Both teams must play the same sport'));
      }
      const refError = await checkReferences({ competitionId });
      if (refError) return res.status(400).json(refError);

      const inserted = await pool.query(
        `INSERT INTO fixtures (home_team_id, away_team_id, match_date, location, competition_id, match_type)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [homeTeamId, awayTeamId, matchDate, venue || null, competitionId || null, matchType || 'league']
      );
      res.status(201).json({ fixture: mapFixture(await loadFixture(inserted.rows[0].id)) });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/fixtures/:id: edit details, postpone or cancel. Only the fields sent are changed.
router.patch(
  '/:id',
  authenticate,
  requireRole('coach', 'admin'),
  [
    idParam,
    body('matchDate').optional().isISO8601({ strict: true }).withMessage('matchDate must be an ISO 8601 date-time')
      .matches(/(Z|[+-]\d{2}:?\d{2})$/).withMessage('matchDate must include a time zone, e.g. 2026-11-06T18:00:00+02:00'),
    body('venue').optional({ values: 'falsy' }).isString().trim().isLength({ max: 255 }),
    body('competitionId').optional({ values: 'null' }).isInt({ min: 1 }).toInt(),
    body('matchType').optional().isIn(MATCH_TYPES).withMessage(`matchType must be one of: ${MATCH_TYPES.join(', ')}`),
    body('status').optional().isIn(EDITABLE_STATUSES)
      .withMessage(`status must be one of: ${EDITABLE_STATUSES.join(', ')}`),
  ],
  validate,
  async (req, res, next) => {
    try {
      const row = await loadFixture(req.params.id);
      if (!row) return res.status(404).json(errorBody('NOT_FOUND', 'Fixture not found'));
      if (!canManage(req.user, row)) {
        return res.status(403).json(errorBody('FORBIDDEN', 'You can only edit fixtures for a team you coach'));
      }
      if (row.status === 'finished' || row.status === 'live') {
        return res.status(409).json(errorBody('FIXTURE_LOCKED', `A ${row.status} fixture can no longer be edited`));
      }

      const b = req.body;
      if (b.competitionId !== undefined && b.competitionId !== null) {
        const refError = await checkReferences({ competitionId: b.competitionId });
        if (refError) return res.status(400).json(refError);
      }

      const sets = [];
      const params = [];
      const set = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };

      if (b.matchDate !== undefined) set('match_date', b.matchDate);
      if (b.venue !== undefined) set('location', b.venue || null);
      if (b.competitionId !== undefined) set('competition_id', b.competitionId || null);
      if (b.matchType !== undefined) set('match_type', b.matchType);
      if (b.status !== undefined) set('status', b.status);

      if (sets.length) {
        sets.push('updated_at = CURRENT_TIMESTAMP');
        params.push(req.params.id);
        await pool.query(`UPDATE fixtures SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }
      res.json({ fixture: mapFixture(await loadFixture(req.params.id)) });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
