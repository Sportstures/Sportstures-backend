// The learner Rankings screen: schools, teams, athletes and regions ranked by points from the
// season's finished results, with last week's movement. How points are earned: utils/rankings.js.
// Public: no login needed, like the rest of the match data.
const express = require('express');
const { query } = require('express-validator');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { optionalAuthenticate } = require('../middleware/auth');
const { teamSelect, teamJoins, mapTeam, categoryLabel } = require('../utils/serializers');
const { PROVINCES } = require('../utils/schools');
const {
  BREAKDOWN, BENCH_SHARE, AGE_GROUPS, ageGroupOf, scoreTeams, addRecords, rank, withTrend,
} = require('../utils/rankings');

const router = express.Router();

const TIME_ZONE = 'Africa/Johannesburg';
const LOCAL_DAY = `(f.match_date AT TIME ZONE '${TIME_ZONE}')::date`;
const TYPES = ['schools', 'teams', 'athletes', 'regions'];
const TREND_DAYS = 7; // "trend" compares with the ranking as it stood this many days ago
const TOP_COUNT = 5; // rows in each overview card

const currentSeason = () => Number(new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric' }).format(new Date()));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Everything one season's rankings are built from.
async function loadSeason(season, { withLineups = false } = {}) {
  const { rows: matchRows } = await pool.query(
    `SELECT f.id, f.match_date, f.home_team_id, f.away_team_id, sc.home_team_score, sc.away_team_score,
            GREATEST(sc.recorded_at, sc.updated_at) AS scored_at
       FROM fixtures f
       JOIN scores sc ON sc.fixture_id = f.id
      WHERE f.status = 'finished' AND EXTRACT(YEAR FROM ${LOCAL_DAY})::int = $1
      ORDER BY f.match_date, f.id`,
    [season]
  );
  const matches = matchRows.map((m) => ({
    id: m.id,
    date: new Date(m.match_date),
    homeTeamId: m.home_team_id,
    awayTeamId: m.away_team_id,
    homeScore: m.home_team_score,
    awayScore: m.away_team_score,
  }));

  const teamIds = [...new Set(matches.flatMap((m) => [m.homeTeamId, m.awayTeamId]))];
  const { rows: teamRows } = teamIds.length
    ? await pool.query(`SELECT ${teamSelect('t', 't')} FROM teams t ${teamJoins('t', 't')} WHERE t.id = ANY($1)`, [teamIds])
    : { rows: [] };
  const teams = new Map(teamRows.map((r) => {
    const team = mapTeam(r, 't');
    return [team.id, { ...team, ageGroup: ageGroupOf(team.level) }];
  }));

  let lineups = [];
  if (withLineups && matches.length) {
    ({ rows: lineups } = await pool.query(
      `SELECT fl.fixture_id, fl.team_id, flp.user_id, flp.role, u.first_name, u.last_name
         FROM fixture_lineups fl
         JOIN fixture_lineup_players flp ON flp.lineup_id = fl.id
         JOIN users u ON u.id = flp.user_id
        WHERE fl.fixture_id = ANY($1)`,
      [matches.map((m) => m.id)]
    ));
  }

  const scored = matchRows.map((m) => m.scored_at).filter(Boolean).map((d) => new Date(d).getTime());
  return { season, matches, teams, lineups, updatedAt: scored.length ? new Date(Math.max(...scored)) : null };
}

const schoolRef = (school) => (school ? { id: school.id, name: school.name, province: school.province, town: school.town } : null);
const teamRef = (team) => ({
  id: team.id, name: team.name, level: team.level, genderCategory: team.genderCategory, ageGroup: team.ageGroup,
});

// Unranked entries of one type from scored matches. Sport and age group decide which teams' matches
// count; province decides which entries are listed.
function entries(type, data, scores, { sportId, ageGroup, province }) {
  const counts = (team) => team
    && (!sportId || (team.sport && team.sport.id === sportId))
    && (!ageGroup || team.ageGroup === ageGroup);
  const listed = (list) => (province ? list.filter((e) => e.province === province) : list);

  const teams = [];
  for (const [teamId, record] of scores.teams) {
    const team = data.teams.get(teamId);
    if (!counts(team)) continue;
    teams.push({
      key: teamId,
      name: team.school ? team.school.name : team.name,
      detail: categoryLabel(team, team.sport),
      province: team.school ? team.school.province : null,
      team: teamRef(team),
      school: schoolRef(team.school),
      sport: team.sport,
      ...record,
    });
  }
  if (type === 'teams') return listed(teams);

  if (type === 'athletes') {
    const athletes = new Map();
    for (const l of data.lineups) {
      const team = data.teams.get(l.team_id);
      const match = scores.byMatch.get(l.fixture_id);
      const earned = match && match.get(l.team_id);
      if (!earned || !counts(team)) continue;
      const share = l.role === 'starter' ? 1 : BENCH_SHARE;
      const a = athletes.get(l.user_id) || {
        key: l.user_id,
        athlete: { id: l.user_id, name: [l.first_name, l.last_name].filter(Boolean).join(' ') },
        records: [],
        byTeam: new Map(),
      };
      a.records.push({
        points: earned.points * share,
        played: 1,
        won: earned.result > 0 ? 1 : 0,
        drawn: earned.result === 0 ? 1 : 0,
        lost: earned.result < 0 ? 1 : 0,
        breakdown: Object.fromEntries(Object.entries(earned.parts).map(([k, v]) => [k, v * share])),
      });
      a.byTeam.set(team.id, (a.byTeam.get(team.id) || 0) + earned.points * share);
      athletes.set(l.user_id, a);
    }
    return listed([...athletes.values()].map(({ records, byTeam, ...a }) => {
      // Named after the team they earned the most for.
      const team = data.teams.get([...byTeam].sort((x, y) => y[1] - x[1])[0][0]);
      return {
        ...a,
        name: a.athlete.name,
        detail: [team.school && team.school.name, team.sport && team.sport.name].filter(Boolean).join(' · '),
        province: team.school ? team.school.province : null,
        school: schoolRef(team.school),
        sport: team.sport,
        team: teamRef(team),
        ...addRecords(records),
      };
    }));
  }

  // A school's teams add up.
  const bySchool = new Map();
  for (const t of teams) {
    if (!t.school) continue;
    if (!bySchool.has(t.school.id)) bySchool.set(t.school.id, { school: t.school, teams: [] });
    bySchool.get(t.school.id).teams.push(t);
  }
  const schools = [...bySchool.values()].map(({ school, teams: list }) => {
    const sportsPlayed = new Set(list.map((t) => t.sport && t.sport.id).filter(Boolean)).size;
    return {
      key: school.id,
      name: school.name,
      detail: `${plural(sportsPlayed, 'sport')} played`,
      province: school.province,
      school,
      sportsPlayed,
      teamsRanked: list.length,
      ...addRecords(list),
    };
  });
  if (type === 'schools') return listed(schools);

  // A region is the average of its schools, so big provinces don't win just by being big.
  const byProvince = new Map();
  for (const s of schools) {
    if (!s.province) continue;
    if (!byProvince.has(s.province)) byProvince.set(s.province, []);
    byProvince.get(s.province).push(s);
  }
  return listed([...byProvince].map(([name, list]) => {
    const total = addRecords(list);
    const n = list.length;
    return {
      key: name,
      name,
      detail: plural(n, 'school'),
      province: name,
      schoolsRanked: n,
      ...total,
      points: total.points / n,
      breakdown: Object.fromEntries(Object.entries(total.breakdown).map(([k, v]) => [k, v / n])),
    };
  }));
}

// The full ranking of one type, numbered, with movement since a week ago.
function rankings(type, data, filters, now = new Date()) {
  const cutoff = new Date(now.getTime() - TREND_DAYS * 24 * 60 * 60 * 1000);
  const current = rank(entries(type, data, scoreTeams(data.matches), filters));
  const previous = rank(entries(type, data, scoreTeams(data.matches.filter((m) => m.date <= cutoff)), filters));
  return withTrend(current, previous).map(({ key, ...row }) => row);
}

const seasonRule = query('season').optional().isInt({ min: 2000, max: 2100 }).withMessage('season must be a year').toInt();

// GET /api/rankings?type=schools|teams|athletes|regions&sportId=&ageGroup=&province=&season=&limit=&offset=
router.get(
  '/',
  optionalAuthenticate,
  [
    query('type').optional().isIn(TYPES).withMessage(`type must be one of ${TYPES.join(', ')}`),
    query('sportId').optional().isInt({ min: 1 }).withMessage('sportId must be a number').toInt(),
    query('ageGroup').optional().isIn(AGE_GROUPS).withMessage(`ageGroup must be one of ${AGE_GROUPS.join(', ')}`),
    query('province').optional().isIn(PROVINCES).withMessage('province must be one of the 9 provinces'),
    seasonRule,
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be 1 to 100').toInt(),
    query('offset').optional().isInt({ min: 0 }).withMessage('offset must be 0 or more').toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const type = req.query.type || 'schools';
      const season = req.query.season || currentSeason();
      const limit = req.query.limit || 10;
      const offset = req.query.offset || 0;
      const { sportId, ageGroup, province } = req.query;

      const data = await loadSeason(season, { withLineups: type === 'athletes' });
      const all = rankings(type, data, { sportId, ageGroup, province });
      const sport = sportId
        ? (await pool.query('SELECT id, name FROM sports WHERE id = $1', [sportId])).rows[0] || null
        : null;

      res.json({
        type,
        season,
        updatedAt: data.updatedAt,
        filters: { sport, ageGroup: ageGroup || null, province: province || null },
        total: all.length,
        limit,
        offset,
        hasMore: offset + limit < all.length,
        rankings: all.slice(offset, offset + limit),
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/rankings/overview?season=: the cards under the table.
router.get('/overview', optionalAuthenticate, [seasonRule], validate, async (req, res, next) => {
  try {
    const season = req.query.season || currentSeason();
    const data = await loadSeason(season);
    const schools = rankings('schools', data, {});
    const teams = rankings('teams', data, {});

    // Each sport's best team.
    const bestBySport = new Map();
    for (const t of teams) if (t.sport && !bestBySport.has(t.sport.id)) bestBySport.set(t.sport.id, t);
    const topSports = [...bestBySport.values()].slice(0, TOP_COUNT).map((t) => ({
      sport: t.sport, label: t.detail, team: t.team, school: t.school, points: t.points,
    }));

    const topRisers = schools.filter((s) => s.trend > 0)
      .sort((a, b) => b.trend - a.trend || a.position - b.position)
      .slice(0, TOP_COUNT);

    const regionLeaders = PROVINCES
      .map((province) => ({ province, leader: schools.find((s) => s.province === province) }))
      .filter((r) => r.leader);

    res.json({ season, updatedAt: data.updatedAt, breakdown: BREAKDOWN, topSports, topRisers, regionLeaders });
  } catch (err) {
    next(err);
  }
});

// GET /api/rankings/filters?season=: what the tabs, chips and filter sheet can offer.
router.get('/filters', optionalAuthenticate, [seasonRule], validate, async (req, res, next) => {
  try {
    const season = req.query.season || currentSeason();
    const data = await loadSeason(season);
    const teams = [...data.teams.values()];
    const sports = new Map(teams.filter((t) => t.sport).map((t) => [t.sport.id, t.sport]));
    const provinces = new Set(teams.map((t) => t.school && t.school.province).filter(Boolean));
    const { rows } = await pool.query(
      `SELECT DISTINCT EXTRACT(YEAR FROM ${LOCAL_DAY})::int AS season
         FROM fixtures f JOIN scores sc ON sc.fixture_id = f.id
        WHERE f.status = 'finished' ORDER BY 1 DESC`
    );

    res.json({
      season,
      seasons: rows.map((r) => r.season),
      types: TYPES,
      sports: [...sports.values()].sort((a, b) => a.name.localeCompare(b.name)),
      ageGroups: AGE_GROUPS,
      provinces: PROVINCES.filter((p) => provinces.has(p)),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
