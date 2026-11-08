// The coach's home screen in one request, mounted under /api/coach.
// Everything here is about the logged-in coach's own team.
const express = require('express');
const pool = require('../../db/config');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  errorBody, FIXTURE_SELECT, FIXTURE_FROM, mapFixture, FULL_TEAM_SELECT, mapFullTeam,
} = require('../utils/serializers');
const { teamRecord } = require('../utils/standings');

const router = express.Router();

// A match counts as "upcoming" until this long after kick-off, so a game in progress is still shown.
const MATCH_WINDOW = "interval '4 hours'";
const LINEUP_DUE_DAYS = 7;
const REPORT_DUE_DAYS = 30;

const fixtures = async (where, params, { order = 'ASC', limit = 50 } = {}) => {
  const { rows } = await pool.query(
    `SELECT ${FIXTURE_SELECT} ${FIXTURE_FROM} WHERE ${where}
     ORDER BY f.match_date ${order}, f.id ${order} LIMIT ${limit}`,
    params
  );
  return rows;
};

const involvesMyTeam = '(f.home_team_id = $1 OR f.away_team_id = $1)';

// GET /api/coach/dashboard
//   team, squadSize, pendingRequests, record, nextMatch, upcoming, recentResults, actionItems
router.get('/dashboard', authenticate, requireRole('coach'), async (req, res, next) => {
  try {
    const teamRows = await pool.query(`${FULL_TEAM_SELECT} WHERE t.coach_id = $1`, [req.user.id]);
    if (!teamRows.rows[0]) {
      return res.status(404).json(errorBody('TEAM_NOT_FOUND', 'This coach does not have a team yet'));
    }
    const team = teamRows.rows[0];
    const teamId = team.t_id;

    const pending = await pool.query(
      "SELECT count(*)::int AS n FROM team_members WHERE team_id = $1 AND status = 'pending'", [teamId]);

    // Season record from every finished fixture with a score.
    const finished = await pool.query(
      `SELECT f.home_team_id, f.away_team_id, sc.home_team_score, sc.away_team_score
         FROM fixtures f JOIN scores sc ON sc.fixture_id = f.id
        WHERE f.status = 'finished' AND ${involvesMyTeam} ORDER BY f.match_date, f.id`, [teamId]);
    const record = teamRecord(teamId, finished.rows.map((r) => ({
      homeTeamId: r.home_team_id, awayTeamId: r.away_team_id, homeScore: r.home_team_score, awayScore: r.away_team_score,
    })));

    const upcomingRows = await fixtures(
      `${involvesMyTeam} AND f.status IN ('scheduled', 'live') AND f.match_date >= now() - ${MATCH_WINDOW}`,
      [teamId], { limit: 5 });
    const recentRows = await fixtures(`${involvesMyTeam} AND f.status = 'finished'`, [teamId], { order: 'DESC', limit: 5 });

    // Things that need the coach to do something.
    const items = [];

    // 1. A lineup for each match in the next week that does not have one yet.
    const needLineup = await fixtures(
      `${involvesMyTeam} AND f.status = 'scheduled' AND f.match_date >= now()
         AND f.match_date < now() + interval '${LINEUP_DUE_DAYS} days'
         AND NOT EXISTS (SELECT 1 FROM fixture_lineups fl WHERE fl.fixture_id = f.id AND fl.team_id = $1)`,
      [teamId]);
    for (const r of needLineup) {
      items.push({ type: 'submit_lineup', dueAt: r.match_date, fixture: mapFixture(r) });
    }

    // 2. Results to record: matches the coach's team hosts that should be over but have no result.
    const needResult = await fixtures(
      `f.home_team_id = $1 AND f.status IN ('scheduled', 'live') AND f.match_date < now() - ${MATCH_WINDOW}`,
      [teamId]);
    for (const r of needResult) {
      items.push({ type: 'record_result', dueAt: r.match_date, fixture: mapFixture(r) });
    }

    // 3. Reports to file for recently finished matches.
    const needReport = await fixtures(
      `${involvesMyTeam} AND f.status = 'finished' AND f.match_date > now() - interval '${REPORT_DUE_DAYS} days'
         AND NOT EXISTS (SELECT 1 FROM fixture_reports fr WHERE fr.fixture_id = f.id)`,
      [teamId], { order: 'DESC' });
    for (const r of needReport) {
      items.push({ type: 'file_report', dueAt: r.match_date, fixture: mapFixture(r) });
    }

    // 4. Players waiting to be approved.
    if (pending.rows[0].n > 0) {
      items.push({ type: 'review_join_requests', dueAt: null, count: pending.rows[0].n });
    }

    // Most urgent first: results already overdue, then by date, then requests (no date).
    const rank = { record_result: 0, submit_lineup: 1, file_report: 2, review_join_requests: 3 };
    items.sort((a, b) => rank[a.type] - rank[b.type] || new Date(a.dueAt || 0) - new Date(b.dueAt || 0));

    const upcoming = upcomingRows.map(mapFixture);
    res.json({
      team: mapFullTeam(team),
      squadSize: team.player_count,
      pendingRequests: pending.rows[0].n,
      record,
      nextMatch: upcoming[0] || null,
      upcoming,
      recentResults: recentRows.map(mapFixture),
      actionItems: items,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
