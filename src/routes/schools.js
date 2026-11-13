// Schools. Reading is public: learners find schools by name, town, province or sport, and open a
// school page with its teams, results and fixtures. Editing a school's location is limited to admins
// and the coach of a team at that school.
const express = require('express');
const { body, query, param } = require('express-validator');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { authenticate, optionalAuthenticate, requireUser, requireRole } = require('../middleware/auth');
const {
  errorBody, FULL_TEAM_SELECT, mapFullTeam, FIXTURE_SELECT, FIXTURE_FROM, mapFixture,
} = require('../utils/serializers');
const { PROVINCES } = require('../utils/schools');
const { withFavorites } = require('../utils/favorites');

const router = express.Router();

const idParam = param('id').isInt({ min: 1 }).withMessage('id must be a number').toInt();

const SELECT = `SELECT s.id, s.name, s.province, s.town,
    (SELECT count(*)::int FROM teams t WHERE t.school_id = s.id) AS team_count,
    COALESCE((SELECT array_agg(DISTINCT sp.name ORDER BY sp.name)
                FROM teams t JOIN sports sp ON sp.id = t.sport_id
               WHERE t.school_id = s.id), ARRAY[]::text[]) AS sports,
    rec.played, rec.won, rec.drawn
  FROM schools s
  -- Finished matches of all the school's teams. A match between two teams of the same school is left out.
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS played,
           count(*) FILTER (WHERE (h.school_id = s.id AND sc.home_team_score > sc.away_team_score)
                               OR (a.school_id = s.id AND sc.away_team_score > sc.home_team_score))::int AS won,
           count(*) FILTER (WHERE sc.home_team_score = sc.away_team_score)::int AS drawn
      FROM fixtures f
      JOIN scores sc ON sc.fixture_id = f.id
      JOIN teams h ON h.id = f.home_team_id
      JOIN teams a ON a.id = f.away_team_id
     WHERE f.status = 'finished' AND (h.school_id = s.id OR a.school_id = s.id)
       AND h.school_id IS DISTINCT FROM a.school_id
  ) rec`;

// The school(s) a signed-in learner or coach belongs to.
async function mySchoolIds(user) {
  if (!user) return new Set();
  const { rows } = await pool.query(
    `SELECT school_id FROM learner_profiles WHERE user_id = $1 AND school_id IS NOT NULL
     UNION SELECT school_id FROM coaches WHERE user_id = $1 AND school_id IS NOT NULL`,
    [user.id]
  );
  return new Set(rows.map((r) => r.school_id));
}

function mapSchool(r, mine = new Set()) {
  return {
    id: r.id,
    name: r.name,
    province: r.province,
    town: r.town,
    teamCount: r.team_count,
    sports: r.sports,
    record: {
      played: r.played,
      won: r.won,
      drawn: r.drawn,
      lost: r.played - r.won - r.drawn,
      winRate: r.played ? Math.round((r.won / r.played) * 100) : null,
    },
    mySchool: mine.has(r.id),
  };
}

// GET /api/schools?q=&province=&sportId=&mine=true&limit=&offset=  (public; mine needs a login)
// q matches the school's name or town. sportId: schools with a team in that sport.
router.get(
  '/',
  optionalAuthenticate,
  [
    query('province').optional().isIn(PROVINCES).withMessage('province must be one of the 9 provinces'),
    query('q').optional().isString().trim().isLength({ max: 100 }),
    query('sportId').optional().isInt({ min: 1 }).withMessage('sportId must be a number').toInt(),
    query('mine').optional().isBoolean().withMessage('mine must be true or false').toBoolean(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { province, q, sportId, mine } = req.query;
      if (mine && !requireUser(req, res)) return;
      const limit = req.query.limit || 50;
      const offset = req.query.offset || 0;
      const where = [];
      const params = [];
      const add = (sql, value) => { params.push(value); where.push(sql.replace(/\?/g, `$${params.length}`)); };

      if (province) add('s.province = ?', province);
      // % and _ are plain text.
      if (q) add('(s.name ILIKE ? OR s.town ILIKE ?)', `%${q.replace(/[\\%_]/g, '\\$&')}%`);
      if (sportId) add('EXISTS (SELECT 1 FROM teams t WHERE t.school_id = s.id AND t.sport_id = ?)', sportId);
      const myIds = await mySchoolIds(req.user);
      if (mine) add('s.id = ANY(?::int[])', [...myIds]);

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (await pool.query(`SELECT count(*)::int AS n FROM schools s ${whereSql}`, params)).rows[0].n;
      const { rows } = await pool.query(
        `${SELECT} ${whereSql} ORDER BY s.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      res.json({
        schools: rows.map((r) => mapSchool(r, myIds)),
        total,
        limit,
        offset,
        hasMore: offset + rows.length < total,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/schools/filters: the chips for the Find Schools screen, each with how many schools match.
router.get('/filters', async (req, res, next) => {
  try {
    const [provinces, sports] = await Promise.all([
      pool.query('SELECT province, count(*)::int AS n FROM schools WHERE province IS NOT NULL GROUP BY province'),
      pool.query(
        `SELECT sp.id, sp.name, count(DISTINCT t.school_id)::int AS n
           FROM teams t JOIN sports sp ON sp.id = t.sport_id
          WHERE t.school_id IS NOT NULL
          GROUP BY sp.id, sp.name ORDER BY sp.name`
      ),
    ]);
    const counts = new Map(provinces.rows.map((r) => [r.province, r.n]));
    res.json({
      provinces: PROVINCES.map((name) => ({ name, schoolCount: counts.get(name) || 0 })),
      sports: sports.rows.map((r) => ({ id: r.id, name: r.name, schoolCount: r.n })),
    });
  } catch (err) {
    next(err);
  }
});

async function loadSchool(id) {
  const { rows } = await pool.query(`${SELECT} WHERE s.id = $1`, [id]);
  return rows[0];
}

// GET /api/schools/:id  (public): the school page. The school with its record, its teams
// (with favorite for a signed-in learner), its latest results and its next matches.
router.get('/:id', optionalAuthenticate, [idParam], validate, async (req, res, next) => {
  try {
    const school = await loadSchool(req.params.id);
    if (!school) return res.status(404).json(errorBody('NOT_FOUND', 'School not found'));
    const ofSchool = '(hmt.school_id = $1 OR amt.school_id = $1)';
    const [teams, results, upcoming, myIds] = await Promise.all([
      pool.query(`${FULL_TEAM_SELECT} WHERE t.school_id = $1 ORDER BY t_sp.name NULLS LAST, t.name`, [school.id]),
      pool.query(
        `SELECT ${FIXTURE_SELECT} ${FIXTURE_FROM} WHERE ${ofSchool} AND f.status = 'finished'
         ORDER BY f.match_date DESC, f.id DESC LIMIT 5`,
        [school.id]
      ),
      pool.query(
        `SELECT ${FIXTURE_SELECT} ${FIXTURE_FROM} WHERE ${ofSchool} AND f.status IN ('scheduled', 'live', 'postponed')
         ORDER BY f.match_date, f.id LIMIT 5`,
        [school.id]
      ),
      mySchoolIds(req.user),
    ]);
    res.json({
      school: mapSchool(school, myIds),
      teams: await withFavorites(teams.rows.map(mapFullTeam), req.user),
      recentResults: results.rows.map(mapFixture),
      upcoming: upcoming.rows.map(mapFixture),
    });
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
      res.json({ school: mapSchool(await loadSchool(school.id), await mySchoolIds(req.user)) });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
