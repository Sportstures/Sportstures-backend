// A signed-in person's favourite sports and teams (and the competitions they follow), which shape
// their feed. Mounted at /api/me/favorites.
const express = require('express');
const { body, param } = require('express-validator');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { errorBody, FULL_TEAM_SELECT, mapFullTeam } = require('../utils/serializers');
const { CATEGORIES, SPORT_SELECT, mapSport } = require('../utils/sports');

const router = express.Router();
router.use(authenticate);

// A sport by its id (12) or its app key ("waterPolo", any case).
async function findSport(value) {
  const byId = /^\d+$/.test(String(value));
  const { rows } = await pool.query(
    `${SPORT_SELECT} WHERE ${byId ? 'id = $1' : 'lower(key) = lower($1)'}`,
    [byId ? Number(value) : String(value)]
  );
  return rows[0] ? mapSport(rows[0]) : null;
}

async function favourites(userId) {
  const [sports, teams, competitions] = await Promise.all([
    pool.query(
      `${SPORT_SELECT} WHERE id IN (SELECT sport_id FROM user_favorite_sports WHERE user_id = $1)
        ORDER BY array_position($2::text[], category) NULLS LAST, sort_order NULLS LAST, name`,
      [userId, CATEGORIES.map((c) => c.key)]
    ),
    pool.query(
      `${FULL_TEAM_SELECT} WHERE t.id IN (SELECT team_id FROM user_favorite_teams WHERE user_id = $1) ORDER BY t.name`,
      [userId]
    ),
    pool.query(
      `SELECT c.id, c.name, sp.id AS sport_id, sp.name AS sport_name
         FROM competition_follows cf
         JOIN competitions c ON c.id = cf.competition_id
         LEFT JOIN sports sp ON sp.id = c.sport_id
        WHERE cf.user_id = $1 ORDER BY c.name`,
      [userId]
    ),
  ]);
  return {
    sports: sports.rows.map(mapSport),
    teams: teams.rows.map((r) => ({ ...mapFullTeam(r), favorite: true })),
    competitions: competitions.rows.map((r) => ({
      id: r.id, name: r.name, sport: r.sport_id ? { id: r.sport_id, name: r.sport_name } : null,
    })),
  };
}

// GET /api/me/favorites: { sports, teams, competitions }.
router.get('/', async (req, res, next) => {
  try {
    res.json(await favourites(req.user.id));
  } catch (err) {
    next(err);
  }
});

// PUT /api/me/favorites/sports  { "sports": ["football", "waterPolo", 7] }
// Replaces the whole list in one go (ids or app keys). An empty list clears it: the feed then shows every sport.
router.put(
  '/sports',
  [body('sports').isArray({ max: 100 }).withMessage('sports must be a list of sport ids or keys')],
  validate,
  async (req, res, next) => {
    let client;
    try {
      const found = await Promise.all(req.body.sports.map(findSport));
      const unknown = req.body.sports.filter((_, i) => !found[i]);
      if (unknown.length) {
        return res.status(400).json({ error: { code: 'UNKNOWN_SPORT', message: 'Unknown sport', details: { sports: unknown } } });
      }
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('DELETE FROM user_favorite_sports WHERE user_id = $1', [req.user.id]);
      await client.query(
        `INSERT INTO user_favorite_sports (user_id, sport_id)
         SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING`,
        [req.user.id, found.map((s) => s.id)]
      );
      await client.query('COMMIT');
      res.json(await favourites(req.user.id));
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      if (client) client.release();
    }
  }
);

// PUT /api/me/favorites/sports/:sport and DELETE: pick or unpick one tile. :sport is an id or app key.
// Both are safe to repeat.
const toggleSport = (on) => async (req, res, next) => {
  try {
    const sport = await findSport(req.params.sport);
    if (!sport) return res.status(404).json(errorBody('NOT_FOUND', 'Sport not found'));
    await pool.query(
      on
        ? 'INSERT INTO user_favorite_sports (user_id, sport_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'
        : 'DELETE FROM user_favorite_sports WHERE user_id = $1 AND sport_id = $2',
      [req.user.id, sport.id]
    );
    res.json({ sport, favorite: on });
  } catch (err) {
    next(err);
  }
};
const sportParam = param('sport').isString().trim().isLength({ min: 1, max: 40 });
router.put('/sports/:sport', [sportParam], validate, toggleSport(true));
router.delete('/sports/:sport', [sportParam], validate, toggleSport(false));

// PUT /api/me/favorites/teams/:teamId and DELETE: favourite or unfavourite a team. Safe to repeat.
const toggleTeam = (on) => async (req, res, next) => {
  try {
    const team = (await pool.query('SELECT id FROM teams WHERE id = $1', [req.params.teamId])).rows[0];
    if (!team) return res.status(404).json(errorBody('NOT_FOUND', 'Team not found'));
    await pool.query(
      on
        ? 'INSERT INTO user_favorite_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'
        : 'DELETE FROM user_favorite_teams WHERE user_id = $1 AND team_id = $2',
      [req.user.id, team.id]
    );
    res.json({ teamId: team.id, favorite: on });
  } catch (err) {
    next(err);
  }
};
const teamParam = param('teamId').isInt({ min: 1 }).withMessage('teamId must be a number').toInt();
router.put('/teams/:teamId', [teamParam], validate, toggleTeam(true));
router.delete('/teams/:teamId', [teamParam], validate, toggleTeam(false));

module.exports = router;
