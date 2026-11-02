const express = require('express');
const { body, query, param } = require('express-validator');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { authenticate, requireRole } = require('../middleware/auth');
const { errorBody, teamSelect, teamJoins, mapTeam } = require('../utils/serializers');
const { buildTable } = require('../utils/standings');

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

// GET /api/competitions/:id/standings: the league table, worked out from finished fixtures.
// Every team with a (non-cancelled) fixture in the competition appears, even before it has played.
router.get(
  '/:id/standings',
  authenticate,
  [param('id').isInt({ min: 1 }).withMessage('id must be a number').toInt()],
  validate,
  async (req, res, next) => {
    try {
      const competitionId = req.params.id;
      const comp = await pool.query(`${SELECT} WHERE c.id = $1`, [competitionId]);
      if (!comp.rows[0]) return res.status(404).json(errorBody('NOT_FOUND', 'Competition not found'));

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
      res.json({ competition: mapCompetition(comp.rows[0]), standings: table });
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
