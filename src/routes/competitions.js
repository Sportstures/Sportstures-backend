const express = require('express');
const { body, query, param } = require('express-validator');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { authenticate, optionalAuthenticate, requireRole, requireUser } = require('../middleware/auth');
const { errorBody, teamSelect, teamJoins, mapTeam } = require('../utils/serializers');
const { buildTable } = require('../utils/standings');
const { PROVINCES } = require('../utils/schools');
const { AGE_GROUPS, ageGroupOf } = require('../utils/rankings');
const { STATUSES, NATIONAL, describe, compare } = require('../utils/competitions');

const router = express.Router();

const TIME_ZONE = 'Africa/Johannesburg';
const REGIONS = [...PROVINCES, NATIONAL];

const SELECT = `SELECT c.id, c.name, c.season, c.created_by, c.province, c.age_group, c.total_rounds,
    to_char(c.start_date, 'YYYY-MM-DD') AS start_date, to_char(c.end_date, 'YYYY-MM-DD') AS end_date,
    sp.id AS sport_id, sp.name AS sport_name
  FROM competitions c LEFT JOIN sports sp ON sp.id = c.sport_id`;

function mapCompetition(r) {
  return {
    id: r.id,
    name: r.name,
    season: r.season,
    sport: r.sport_id ? { id: r.sport_id, name: r.sport_name } : null,
  };
}

// The full card for each competition row: status, region, age group, dates, teams, rounds, leader,
// and whether the signed-in person follows it.
async function describeAll(rows, user) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [fixtures, today, follows] = await Promise.all([
    pool.query(
      `SELECT f.id, f.competition_id, f.home_team_id, f.away_team_id, f.status, f.match_type,
              to_char((f.match_date AT TIME ZONE '${TIME_ZONE}')::date, 'YYYY-MM-DD') AS day,
              sc.home_team_score, sc.away_team_score
         FROM fixtures f LEFT JOIN scores sc ON sc.fixture_id = f.id
        WHERE f.competition_id = ANY($1) AND f.status <> 'cancelled'
        ORDER BY f.match_date, f.id`,
      [ids]
    ),
    pool.query(`SELECT to_char((now() AT TIME ZONE '${TIME_ZONE}')::date, 'YYYY-MM-DD') AS today`),
    user
      ? pool.query('SELECT competition_id FROM competition_follows WHERE user_id = $1 AND competition_id = ANY($2)', [user.id, ids])
      : { rows: [] },
  ]);

  const teamIds = [...new Set(fixtures.rows.flatMap((f) => [f.home_team_id, f.away_team_id]))];
  const teamRows = teamIds.length
    ? (await pool.query(`SELECT ${teamSelect('t', 't')} FROM teams t ${teamJoins('t', 't')} WHERE t.id = ANY($1)`, [teamIds])).rows
    : [];
  const teams = new Map(teamRows.map((r) => {
    const team = mapTeam(r, 't');
    return [team.id, { ...team, ageGroup: ageGroupOf(team.level) }];
  }));

  const byCompetition = new Map(ids.map((id) => [id, []]));
  for (const f of fixtures.rows) {
    byCompetition.get(f.competition_id).push({
      id: f.id,
      homeTeamId: f.home_team_id,
      awayTeamId: f.away_team_id,
      status: f.status,
      matchType: f.match_type,
      day: f.day,
      homeScore: f.home_team_score,
      awayScore: f.away_team_score,
    });
  }
  const followed = new Set(follows.rows.map((r) => r.competition_id));

  return rows.map((r) => ({
    ...mapCompetition(r),
    ...describe(r, byCompetition.get(r.id), teams, today.rows[0].today),
    following: followed.has(r.id),
  }));
}

const loadOne = async (id) => (await pool.query(`${SELECT} WHERE c.id = $1`, [id])).rows[0];
const idParam = param('id').isInt({ min: 1 }).withMessage('id must be a number').toInt();

// GET /api/competitions?status=&sportId=&region=&q=&following=true
// `counts` gives the number in each status tab for the other filters, so the tabs can show them.
router.get(
  '/',
  optionalAuthenticate,
  [
    query('status').optional().isIn(STATUSES).withMessage(`status must be one of ${STATUSES.join(', ')}`),
    query('sportId').optional().isInt({ min: 1 }).withMessage('sportId must be a number').toInt(),
    query('region').optional().isIn(REGIONS).withMessage('region must be a province or National'),
    query('q').optional().isString().trim().isLength({ max: 100 }).withMessage('q must be 100 characters or fewer'),
    query('following').optional().isBoolean().withMessage('following must be true or false').toBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { status, sportId, region, q, following } = req.query;
      if (following && !requireUser(req, res)) return;

      const where = [];
      const params = [];
      if (sportId) { params.push(sportId); where.push(`c.sport_id = $${params.length}`); }
      if (q) { params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`); where.push(`c.name ILIKE $${params.length}`); }
      if (following) {
        params.push(req.user.id);
        where.push(`EXISTS (SELECT 1 FROM competition_follows cf WHERE cf.competition_id = c.id AND cf.user_id = $${params.length})`);
      }
      const { rows } = await pool.query(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, params);

      const all = (await describeAll(rows, req.user)).filter((c) => !region || c.region === region);
      const counts = { all: all.length, ...Object.fromEntries(STATUSES.map((s) => [s, all.filter((c) => c.status === s).length])) };
      res.json({ counts, competitions: all.filter((c) => !status || c.status === status).sort(compare) });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/competitions/:id: one competition card.
router.get('/:id', optionalAuthenticate, [idParam], validate, async (req, res, next) => {
  try {
    const row = await loadOne(req.params.id);
    if (!row) return res.status(404).json(errorBody('NOT_FOUND', 'Competition not found'));
    res.json({ competition: (await describeAll([row], req.user))[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/competitions/:id/follow and DELETE: turn alerts for a competition on or off.
// Both are safe to repeat.
const follow = (on) => async (req, res, next) => {
  try {
    if (!(await loadOne(req.params.id))) return res.status(404).json(errorBody('NOT_FOUND', 'Competition not found'));
    await pool.query(
      on
        ? 'INSERT INTO competition_follows (user_id, competition_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'
        : 'DELETE FROM competition_follows WHERE user_id = $1 AND competition_id = $2',
      [req.user.id, req.params.id]
    );
    res.json({ competitionId: req.params.id, following: on });
  } catch (err) {
    next(err);
  }
};
router.put('/:id/follow', authenticate, [idParam], validate, follow(true));
router.delete('/:id/follow', authenticate, [idParam], validate, follow(false));

// GET /api/competitions/:id/standings: the league table, worked out from finished fixtures.
// Every team with a (non-cancelled) fixture in the competition appears, even before it has played.
router.get(
  '/:id/standings',
  optionalAuthenticate,
  [idParam],
  validate,
  async (req, res, next) => {
    try {
      const competitionId = req.params.id;
      const comp = await loadOne(competitionId);
      if (!comp) return res.status(404).json(errorBody('NOT_FOUND', 'Competition not found'));

      const ids = await pool.query(
        `SELECT home_team_id AS id FROM fixtures WHERE competition_id = $1 AND status <> 'cancelled'
         UNION
         SELECT away_team_id AS id FROM fixtures WHERE competition_id = $1 AND status <> 'cancelled'`,
        [competitionId]
      );
      const teamRows = ids.rows.length
        ? (await pool.query(
          `SELECT ${teamSelect('t', 't')} FROM teams t ${teamJoins('t', 't')} WHERE t.id = ANY($1::int[])`,
          [ids.rows.map((r) => r.id)]
        )).rows
        : [];

      const finished = await pool.query(
        `SELECT f.home_team_id, f.away_team_id, sc.home_team_score, sc.away_team_score
           FROM fixtures f JOIN scores sc ON sc.fixture_id = f.id
          WHERE f.competition_id = $1 AND f.status = 'finished'
          ORDER BY f.match_date, f.id`,
        [competitionId]
      );

      const table = buildTable(
        teamRows.map((r) => mapTeam(r, 't')),
        finished.rows.map((r) => ({
          homeTeamId: r.home_team_id,
          awayTeamId: r.away_team_id,
          homeScore: r.home_team_score,
          awayScore: r.away_team_score,
        }))
      );
      res.json({ competition: mapCompetition(comp), standings: table });
    } catch (err) {
      next(err);
    }
  }
);

// Optional details a coach or admin can set when creating or editing a competition.
// Anything left out is worked out from the fixtures (see utils/competitions.js).
const detailRules = [
  body('region').optional({ values: 'null' }).isIn(REGIONS).withMessage('region must be a province or National'),
  body('ageGroup').optional({ values: 'null' }).isIn(AGE_GROUPS).withMessage(`ageGroup must be one of ${AGE_GROUPS.join(', ')}`),
  body(['startDate', 'endDate']).optional({ values: 'null' })
    .isDate({ format: 'YYYY-MM-DD', strictMode: true }).withMessage('dates must be YYYY-MM-DD'),
  body('rounds').optional({ values: 'null' }).isInt({ min: 1, max: 500 }).withMessage('rounds must be 1 to 500').toInt(),
  body('endDate').optional({ values: 'null' }).custom((end, { req }) => {
    if (req.body.startDate && end < req.body.startDate) throw new Error('endDate must be on or after startDate');
    return true;
  }),
];

async function unknownSport(sportId) {
  if (!sportId) return false;
  return !(await pool.query('SELECT 1 FROM sports WHERE id = $1', [sportId])).rows[0];
}

const duplicate = (err, res) => {
  if (err.code === '23505') {
    res.status(409).json(errorBody('COMPETITION_EXISTS', 'A competition with this name already exists'));
    return true;
  }
  if (err.code === '23514') {
    res.status(400).json(errorBody('INVALID_DATES', 'endDate must be on or after startDate'));
    return true;
  }
  return false;
};

// POST /api/competitions (coach or admin)
router.post(
  '/',
  authenticate,
  requireRole('coach', 'admin'),
  [
    body('name').isString().trim().isLength({ min: 1, max: 255 }).withMessage('name is required (max 255 characters)'),
    body('sportId').optional({ values: 'null' }).isInt({ min: 1 }).toInt(),
    body('season').optional({ values: 'falsy' }).isString().trim().isLength({ max: 20 }),
    ...detailRules,
  ],
  validate,
  async (req, res, next) => {
    try {
      const { name, sportId, season, region, ageGroup, startDate, endDate, rounds } = req.body;
      if (await unknownSport(sportId)) return res.status(400).json(errorBody('UNKNOWN_SPORT', 'Unknown sportId'));
      const inserted = await pool.query(
        `INSERT INTO competitions (name, sport_id, season, created_by, province, age_group, start_date, end_date, total_rounds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [name, sportId || null, season || null, req.user.id, region || null, ageGroup || null,
          startDate || null, endDate || null, rounds || null]
      );
      res.status(201).json({ competition: (await describeAll([await loadOne(inserted.rows[0].id)], req.user))[0] });
    } catch (err) {
      if (duplicate(err, res)) return;
      next(err);
    }
  }
);

// PATCH /api/competitions/:id: the coach who created it, or an admin. Send null to clear a detail
// so it is worked out from the fixtures again.
const COLUMNS = {
  name: 'name', sportId: 'sport_id', season: 'season', region: 'province', ageGroup: 'age_group',
  startDate: 'start_date', endDate: 'end_date', rounds: 'total_rounds',
};
router.patch(
  '/:id',
  authenticate,
  requireRole('coach', 'admin'),
  [
    idParam,
    body('name').optional().isString().trim().isLength({ min: 1, max: 255 }).withMessage('name must be 1 to 255 characters'),
    body('sportId').optional({ values: 'null' }).isInt({ min: 1 }).toInt(),
    body('season').optional({ values: 'null' }).isString().trim().isLength({ max: 20 }),
    ...detailRules,
  ],
  validate,
  async (req, res, next) => {
    try {
      const row = await loadOne(req.params.id);
      if (!row) return res.status(404).json(errorBody('NOT_FOUND', 'Competition not found'));
      if (req.user.role !== 'admin' && row.created_by !== req.user.id) {
        return res.status(403).json(errorBody('FORBIDDEN', 'Only the coach who created this competition can edit it'));
      }
      if (await unknownSport(req.body.sportId)) return res.status(400).json(errorBody('UNKNOWN_SPORT', 'Unknown sportId'));

      const sets = [];
      const params = [];
      for (const [field, column] of Object.entries(COLUMNS)) {
        if (req.body[field] === undefined) continue;
        params.push(req.body[field] === '' ? null : req.body[field]);
        sets.push(`${column} = $${params.length}`);
      }
      if (sets.length) {
        params.push(row.id);
        await pool.query(`UPDATE competitions SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }
      res.json({ competition: (await describeAll([await loadOne(row.id)], req.user))[0] });
    } catch (err) {
      if (duplicate(err, res)) return;
      next(err);
    }
  }
);

module.exports = router;
