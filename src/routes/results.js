// The learner Results screen: finished matches grouped by day, a summary, filters and top standings.
// Public: no login needed, like the rest of the match data.
const express = require('express');
const { query } = require('express-validator');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { optionalAuthenticate } = require('../middleware/auth');
const { FIXTURE_SELECT, FIXTURE_FROM, mapFixture, mapTeam, categoryLabel } = require('../utils/serializers');
const { PROVINCES } = require('../utils/schools');
const { buildTable } = require('../utils/standings');

const router = express.Router();

// Days, "today" and the period tabs follow South African time (UTC+2), so a match at 00:30 on
// Saturday in Johannesburg is a Saturday result even though it is still Friday 22:30 in UTC.
const TIME_ZONE = 'Africa/Johannesburg';
const LOCAL_DAY = `(f.match_date AT TIME ZONE '${TIME_ZONE}')::date`;
const LOCAL_TODAY = `(now() AT TIME ZONE '${TIME_ZONE}')::date`;

// The screen's period tabs. Weeks start on Monday.
const PERIODS = {
  all: null,
  today: `${LOCAL_DAY} = ${LOCAL_TODAY}`,
  yesterday: `${LOCAL_DAY} = ${LOCAL_TODAY} - 1`,
  week: `${LOCAL_DAY} >= date_trunc('week', ${LOCAL_TODAY})::date`,
  month: `${LOCAL_DAY} >= date_trunc('month', ${LOCAL_TODAY})::date`,
};

const isoDay = (name) => query(name).optional()
  .isDate({ format: 'YYYY-MM-DD', strictMode: true }).withMessage(`${name} must be a YYYY-MM-DD date`);

const commonRules = [
  query('sportId').optional().isInt({ min: 1 }).withMessage('sportId must be a number').toInt(),
  query('province').optional().isIn(PROVINCES).withMessage('province must be one of the 9 provinces'),
];

// Treats % and _ in a search as plain text.
const escapeLike = (text) => text.replace(/[\\%_]/g, '\\$&');

// WHERE clause for finished, scored fixtures matching the filters in `q`.
function resultFilters(q) {
  const where = ["f.status = 'finished'", 'sc.fixture_id IS NOT NULL'];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace(/\?/g, `$${params.length}`)); };

  if (q.sportId) add('(hmt.sport_id = ? OR amt.sport_id = ?)', q.sportId);
  if (q.province) add('(h_sc.province = ? OR a_sc.province = ?)', q.province);
  if (q.from) add(`${LOCAL_DAY} >= ?::date`, q.from);
  if (q.to) add(`${LOCAL_DAY} <= ?::date`, q.to);
  if (q.q) {
    add(`(hmt.name ILIKE ? OR amt.name ILIKE ? OR h_sc.name ILIKE ? OR a_sc.name ILIKE ? OR f.location ILIKE ?)`,
      `%${escapeLike(q.q)}%`);
  }
  if (PERIODS[q.period]) where.push(PERIODS[q.period]);

  return { where: `WHERE ${where.join(' AND ')}`, params };
}

const withCategory = (row) => {
  const fixture = mapFixture(row);
  return { ...fixture, category: categoryLabel(fixture.homeTeam, fixture.sport) };
};

// GET /api/results
//   q (team, school or venue), sportId, province, period=all|today|yesterday|week|month,
//   from, to (YYYY-MM-DD, South African days), limit (days per page, default 3), offset (days to skip)
router.get(
  '/',
  optionalAuthenticate,
  [
    ...commonRules,
    query('q').optional().isString().trim().isLength({ max: 100 }).withMessage('q must be 100 characters or fewer'),
    query('period').optional().isIn(Object.keys(PERIODS)).withMessage(`period must be one of ${Object.keys(PERIODS).join(', ')}`),
    isoDay('from'),
    isoDay('to'),
    query('limit').optional().isInt({ min: 1, max: 31 }).withMessage('limit must be 1 to 31 days').toInt(),
    query('offset').optional().isInt({ min: 0 }).withMessage('offset must be 0 or more').toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const limit = req.query.limit || 3;
      const offset = req.query.offset || 0;
      const { where, params } = resultFilters(req.query);

      // Totals for the summary card cover every matching result, not just this page.
      const { rows: [totals] } = await pool.query(
        `SELECT count(*)::int AS played,
                count(*) FILTER (WHERE sc.home_team_score > sc.away_team_score)::int AS home_wins,
                count(*) FILTER (WHERE sc.home_team_score < sc.away_team_score)::int AS away_wins,
                count(*) FILTER (WHERE sc.home_team_score = sc.away_team_score)::int AS draws,
                COALESCE(sum(sc.home_team_score + sc.away_team_score), 0)::int AS total_scored,
                count(DISTINCT ${LOCAL_DAY})::int AS total_days,
                to_char(${LOCAL_TODAY}, 'YYYY-MM-DD') AS today
         ${FIXTURE_FROM} ${where}`,
        params
      );

      // The page's days, newest first, then every result on those days.
      const { rows: dayRows } = await pool.query(
        `SELECT to_char(${LOCAL_DAY}, 'YYYY-MM-DD') AS day
         ${FIXTURE_FROM} ${where}
         GROUP BY 1 ORDER BY 1 DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      const pageDays = dayRows.map((r) => r.day);

      const { rows } = pageDays.length
        ? await pool.query(
          `SELECT ${FIXTURE_SELECT}, to_char(${LOCAL_DAY}, 'YYYY-MM-DD') AS local_day
           ${FIXTURE_FROM} ${where} AND to_char(${LOCAL_DAY}, 'YYYY-MM-DD') = ANY($${params.length + 1}::text[])
           ORDER BY f.match_date DESC, f.id DESC`,
          [...params, pageDays]
        )
        : { rows: [] };

      const days = pageDays.map((date) => {
        const results = rows.filter((r) => r.local_day === date).map(withCategory);
        return { date, isToday: date === totals.today, count: results.length, results };
      });

      res.json({
        today: totals.today,
        summary: {
          matchesPlayed: totals.played,
          homeWins: totals.home_wins,
          awayWins: totals.away_wins,
          draws: totals.draws,
          totalScored: totals.total_scored,
        },
        days,
        limit,
        offset,
        totalDays: totals.total_days,
        hasMore: offset + pageDays.length < totals.total_days,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/results/filters: the sports and provinces that have results, for the chips and filter sheet.
router.get('/filters', optionalAuthenticate, async (req, res, next) => {
  try {
    const finished = "WHERE f.status = 'finished' AND sc.fixture_id IS NOT NULL";
    const [sports, provinces] = await Promise.all([
      pool.query(
        `SELECT DISTINCT sp.id, sp.name
           FROM fixtures f
           JOIN scores sc ON sc.fixture_id = f.id
           JOIN teams t ON t.id IN (f.home_team_id, f.away_team_id)
           JOIN sports sp ON sp.id = t.sport_id
          ${finished}
          ORDER BY sp.name`
      ),
      pool.query(
        `SELECT DISTINCT s.province
           FROM fixtures f
           JOIN scores sc ON sc.fixture_id = f.id
           JOIN teams t ON t.id IN (f.home_team_id, f.away_team_id)
           JOIN schools s ON s.id = t.school_id
          ${finished} AND s.province IS NOT NULL
          ORDER BY s.province`
      ),
    ]);
    res.json({
      sports: sports.rows,
      provinces: provinces.rows.map((r) => r.province),
      periods: Object.keys(PERIODS),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/results/standings?sportId=&province=&limit=
// A table of schools from every finished result, same points rules as league tables (see utils/standings.js).
// With a province, only that province's schools are listed (their matches against anyone still count).
router.get(
  '/standings',
  optionalAuthenticate,
  [
    ...commonRules,
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be 1 to 100').toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { sportId, province, limit } = req.query;
      const { where, params } = resultFilters({ sportId, province });
      const { rows } = await pool.query(
        `SELECT ${FIXTURE_SELECT} ${FIXTURE_FROM} ${where} ORDER BY f.match_date, f.id`,
        params
      );

      // A school's teams count together. Matches between two teams of the same school are left out.
      const schools = new Map();
      const fixtures = [];
      for (const row of rows) {
        const home = mapTeam(row, 'h').school;
        const away = mapTeam(row, 'a').school;
        if (!home || !away || home.id === away.id) continue;
        schools.set(home.id, home);
        schools.set(away.id, away);
        fixtures.push({
          homeTeamId: home.id,
          awayTeamId: away.id,
          homeScore: row.home_team_score,
          awayScore: row.away_team_score,
        });
      }

      // Every match still counts towards a listed school's record, including those against other provinces.
      const listed = [...schools.values()].filter((school) => !province || school.province === province);
      const table = buildTable(listed, fixtures).map(({ team, ...row }) => ({ ...row, school: team }));

      res.json({
        sport: sportId ? (await pool.query('SELECT id, name FROM sports WHERE id = $1', [sportId])).rows[0] || null : null,
        province: province || null,
        totalSchools: table.length,
        standings: limit ? table.slice(0, limit) : table,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
