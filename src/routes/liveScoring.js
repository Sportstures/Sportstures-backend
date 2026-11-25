// Live scoring: either coach starts the match, coaches add goals as they happen, the OTHER team's
// coach confirms or disputes each one, and finishing the match writes the final score.
// Mounted at /api/fixtures, next to fixtures.js.
//
// Only confirmed goals count in the live score. Goals nobody answered are confirmed at full time;
// disputed goals never count unless the other coach or an admin confirms them before then.
const express = require('express');
const { body, param } = require('express-validator');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { authenticate, optionalAuthenticate, requireRole } = require('../middleware/auth');
const { errorBody, FIXTURE_SELECT, FIXTURE_FROM, mapFixture } = require('../utils/serializers');
const notify = require('../utils/notifications');

const router = express.Router();

// A coach can start the match up to this long before the scheduled kick-off.
const START_EARLY_MINUTES = 60;

const idParam = param('id').isInt({ min: 1 }).withMessage('id must be a number').toInt();
const goalIdParam = param('goalId').isInt({ min: 1 }).withMessage('goalId must be a number').toInt();
const coachOrAdmin = [authenticate, requireRole('coach', 'admin')];

async function loadFixture(id, db = pool, lock = false) {
  if (lock) await db.query('SELECT id FROM fixtures WHERE id = $1 FOR UPDATE', [id]);
  const { rows } = await db.query(`SELECT ${FIXTURE_SELECT} ${FIXTURE_FROM} WHERE f.id = $1`, [id]);
  return rows[0];
}

// The team in this fixture that the user coaches, or null.
function coachedTeamId(user, f) {
  if (!user || user.role !== 'coach') return null;
  if (f.h_coach_user_id === user.id) return f.h_id;
  if (f.a_coach_user_id === user.id) return f.a_id;
  return null;
}
const coachOf = (f, teamId) => (teamId === f.h_id ? f.h_coach_user_id : f.a_coach_user_id);
const otherTeam = (f, teamId) => (teamId === f.h_id ? f.a_id : f.h_id);
const fullName = (first, last) => [first, last].filter(Boolean).join(' ') || null;

const GOAL_SELECT = `SELECT g.*, t.name AS team_name,
    pu.first_name AS player_first_name, pu.last_name AS player_last_name,
    au.first_name AS adder_first_name, au.last_name AS adder_last_name
  FROM fixture_goals g
  JOIN teams t ON t.id = g.team_id
  LEFT JOIN users pu ON pu.id = g.player_id
  LEFT JOIN users au ON au.id = g.added_by`;
const GOAL_ORDER = 'ORDER BY g.minute ASC NULLS LAST, g.created_at ASC, g.id ASC';

function mapGoal(g, f, user) {
  const live = f.status === 'live';
  const admin = Boolean(user && user.role === 'admin');
  // The side that confirms is the one that didn't add it. Goals an admin added are already confirmed.
  const confirmer = g.added_by_team_id ? coachOf(f, otherTeam(f, g.added_by_team_id)) : null;
  const adder = g.added_by_team_id ? coachOf(f, g.added_by_team_id) : null;
  const isConfirmer = Boolean(user && (admin || (confirmer && confirmer === user.id)));
  return {
    id: g.id,
    team: { id: g.team_id, name: g.team_name },
    side: g.team_id === f.h_id ? 'home' : 'away',
    points: g.points,
    minute: g.minute,
    player: g.player_id ? { id: g.player_id, name: fullName(g.player_first_name, g.player_last_name) } : null,
    status: g.status,
    autoConfirmed: g.auto_confirmed,
    addedBy: g.added_by ? { id: g.added_by, name: fullName(g.adder_first_name, g.adder_last_name) } : null,
    addedByTeamId: g.added_by_team_id,
    confirmedAt: g.confirmed_at,
    disputeReason: g.dispute_reason,
    disputedAt: g.disputed_at,
    createdAt: g.created_at,
    canConfirm: live && (g.status === 'pending' || g.status === 'disputed') && isConfirmer,
    canDispute: live && g.status === 'pending' && isConfirmer,
    canDelete: live && Boolean(user && (admin || (adder && adder === user.id))),
  };
}

async function goalsBody(fixtureId, user, db = pool) {
  const f = await loadFixture(fixtureId, db);
  const { rows } = await db.query(`${GOAL_SELECT} WHERE g.fixture_id = $1 ${GOAL_ORDER}`, [fixtureId]);
  const goals = rows.map((g) => mapGoal(g, f, user));
  const total = (side, status, value) => goals.filter((g) => g.side === side && g.status === status)
    .reduce((n, g) => n + value(g), 0);
  return {
    fixture: mapFixture(f),
    goals,
    // Confirmed goals only (the score to show), and how many goals are still waiting on each side.
    score: { home: total('home', 'confirmed', (g) => g.points), away: total('away', 'confirmed', (g) => g.points) },
    pending: { home: total('home', 'pending', () => 1), away: total('away', 'pending', () => 1) },
    disputed: { home: total('home', 'disputed', () => 1), away: total('away', 'disputed', () => 1) },
  };
}

// Runs `work` in a transaction with the fixture locked, after checking it exists, the user is one of
// its coaches (or an admin) and, unless allowStatuses says otherwise, that it is live.
async function withFixture(req, res, work, { allowStatuses = ['live'] } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const f = await loadFixture(req.params.id, client, true);
    const fail = async (status, code, message) => {
      await client.query('ROLLBACK');
      res.status(status).json(errorBody(code, message));
      return null;
    };
    if (!f) return await fail(404, 'NOT_FOUND', 'Fixture not found');
    if (req.user.role !== 'admin' && !coachedTeamId(req.user, f)) {
      return await fail(403, 'FORBIDDEN', 'Only the coaches of the two teams can score this match');
    }
    if (!allowStatuses.includes(f.status)) {
      return await fail(409, f.status === 'scheduled' ? 'MATCH_NOT_STARTED' : 'MATCH_NOT_LIVE',
        f.status === 'scheduled' ? 'Start the match first' : `The match is ${f.status}`);
    }
    const result = await work(client, f, fail);
    if (result === null) return null; // work() already failed and rolled back
    await client.query('COMMIT');
    return { f, result };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// POST /api/fixtures/:id/start: kick-off. Either team's coach, or an admin.
router.post('/:id/start', coachOrAdmin, [idParam], validate, async (req, res, next) => {
  try {
    const done = await withFixture(req, res, async (client, f, fail) => {
      const opensAt = new Date(new Date(f.match_date).getTime() - START_EARLY_MINUTES * 60000);
      if (new Date() < opensAt) {
        return fail(409, 'TOO_EARLY', `The match can be started from ${START_EARLY_MINUTES} minutes before kick-off`);
      }
      await client.query(
        "UPDATE fixtures SET status = 'live', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [f.id]
      );
      return true;
    }, { allowStatuses: ['scheduled'] });
    if (!done) return;
    res.json(await goalsBody(req.params.id, req.user));
  } catch (err) {
    next(err);
  }
});

// GET /api/fixtures/:id/goals: public, like the match itself.
router.get('/:id/goals', optionalAuthenticate, [idParam], validate, async (req, res, next) => {
  try {
    const f = await loadFixture(req.params.id);
    if (!f) return res.status(404).json(errorBody('NOT_FOUND', 'Fixture not found'));
    res.json(await goalsBody(f.id, req.user));
  } catch (err) {
    next(err);
  }
});

// POST /api/fixtures/:id/goals  { teamId?, playerId?, minute?, points? }
// A coach adds a goal (for their own team by default). It waits for the other coach to confirm.
router.post(
  '/:id/goals',
  coachOrAdmin,
  [
    idParam,
    body('teamId').optional({ values: 'null' }).isInt({ min: 1 }).withMessage('teamId must be a number').toInt(),
    body('playerId').optional({ values: 'null' }).isInt({ min: 1 }).withMessage('playerId must be a number').toInt(),
    body('minute').optional({ values: 'null' }).isInt({ min: 0, max: 200 }).withMessage('minute must be from 0 to 200').toInt(),
    body('points').optional({ values: 'null' }).isInt({ min: 1, max: 10 }).withMessage('points must be from 1 to 10').toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const b = req.body;
      let adderTeamId = null;
      const done = await withFixture(req, res, async (client, f, fail) => {
        adderTeamId = coachedTeamId(req.user, f);
        const teamId = b.teamId || adderTeamId;
        if (!teamId) return fail(400, 'TEAM_REQUIRED', 'Admins must send teamId');
        if (teamId !== f.h_id && teamId !== f.a_id) return fail(400, 'TEAM_NOT_PLAYING', 'teamId must be one of the two teams');
        if (b.playerId) {
          const member = await client.query(
            "SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'active'", [teamId, b.playerId]
          );
          if (!member.rows[0]) return fail(400, 'NOT_ON_TEAM', 'That player is not in the scoring team\'s squad');
        }
        // An admin is trusted: their goals count straight away.
        const confirmed = !adderTeamId;
        const { rows: [goal] } = await client.query(
          `INSERT INTO fixture_goals (fixture_id, team_id, player_id, minute, points, status, added_by, added_by_team_id,
                                      confirmed_by, confirmed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [f.id, teamId, b.playerId || null, b.minute ?? null, b.points || 1, confirmed ? 'confirmed' : 'pending',
            req.user.id, adderTeamId, confirmed ? req.user.id : null, confirmed ? new Date() : null]
        );
        return goal.id;
      });
      if (!done) return;
      const result = await goalsBody(done.f.id, req.user);
      const goal = result.goals.find((g) => g.id === done.result);
      if (adderTeamId) {
        await notify.goal('goal_confirmation_needed', goal, done.f.id, coachOf(done.f, otherTeam(done.f, adderTeamId)), req.user.id);
      }
      res.status(201).json({ goal, ...result });
    } catch (err) {
      next(err);
    }
  }
);

// Loads one goal of this fixture (locked), or fails with 404.
async function lockGoal(client, f, goalId, fail) {
  const { rows: [g] } = await client.query(
    'SELECT * FROM fixture_goals WHERE id = $1 AND fixture_id = $2 FOR UPDATE', [goalId, f.id]
  );
  if (!g) return fail(404, 'GOAL_NOT_FOUND', 'Goal not found');
  return g;
}

const isConfirmerOf = (user, f, g) => user.role === 'admin'
  || (g.added_by_team_id && coachOf(f, otherTeam(f, g.added_by_team_id)) === user.id);

// POST /api/fixtures/:id/goals/:goalId/confirm: the other team's coach (or an admin) confirms a goal.
// A disputed goal can also be confirmed, if they change their mind.
router.post('/:id/goals/:goalId/confirm', coachOrAdmin, [idParam, goalIdParam], validate, async (req, res, next) => {
  try {
    const done = await withFixture(req, res, async (client, f, fail) => {
      const g = await lockGoal(client, f, req.params.goalId, fail);
      if (!g) return null;
      if (!isConfirmerOf(req.user, f, g)) return fail(403, 'FORBIDDEN', 'The other team\'s coach confirms this goal');
      if (g.status === 'confirmed') return fail(409, 'ALREADY_CONFIRMED', 'This goal is already confirmed');
      await client.query(
        `UPDATE fixture_goals SET status = 'confirmed', confirmed_by = $2, confirmed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [g.id, req.user.id]
      );
      return g.id;
    });
    if (!done) return;
    const result = await goalsBody(done.f.id, req.user);
    res.json({ goal: result.goals.find((g) => g.id === done.result), ...result });
  } catch (err) {
    next(err);
  }
});

// POST /api/fixtures/:id/goals/:goalId/dispute  { reason? }: the other team's coach rejects a goal.
// It stops counting; the coach who added it can delete it, or it can still be confirmed later.
router.post(
  '/:id/goals/:goalId/dispute',
  coachOrAdmin,
  [idParam, goalIdParam, body('reason').optional({ values: 'null' }).isString().trim().isLength({ max: 500 })
    .withMessage('reason can be at most 500 characters')],
  validate,
  async (req, res, next) => {
    try {
      let addedByTeamId = null;
      const done = await withFixture(req, res, async (client, f, fail) => {
        const g = await lockGoal(client, f, req.params.goalId, fail);
        if (!g) return null;
        if (!isConfirmerOf(req.user, f, g)) return fail(403, 'FORBIDDEN', 'The other team\'s coach confirms or disputes this goal');
        if (g.status !== 'pending') return fail(409, 'GOAL_NOT_PENDING', `This goal is already ${g.status}`);
        await client.query(
          `UPDATE fixture_goals SET status = 'disputed', dispute_reason = $2, disputed_by = $3, disputed_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [g.id, req.body.reason || null, req.user.id]
        );
        addedByTeamId = g.added_by_team_id;
        return g.id;
      });
      if (!done) return;
      const result = await goalsBody(done.f.id, req.user);
      const goal = result.goals.find((g) => g.id === done.result);
      await notify.goal('goal_disputed', goal, done.f.id, coachOf(done.f, addedByTeamId), req.user.id);
      res.json({ goal, ...result });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/fixtures/:id/goals/:goalId: the side that added a goal takes it back (or an admin).
router.delete('/:id/goals/:goalId', coachOrAdmin, [idParam, goalIdParam], validate, async (req, res, next) => {
  try {
    const done = await withFixture(req, res, async (client, f, fail) => {
      const g = await lockGoal(client, f, req.params.goalId, fail);
      if (!g) return null;
      const adder = g.added_by_team_id ? coachOf(f, g.added_by_team_id) : null;
      if (req.user.role !== 'admin' && adder !== req.user.id) {
        return fail(403, 'FORBIDDEN', 'Only the coach who added this goal can remove it');
      }
      await client.query('DELETE FROM fixture_goals WHERE id = $1', [g.id]);
      return true;
    });
    if (!done) return;
    res.json(await goalsBody(done.f.id, req.user));
  } catch (err) {
    next(err);
  }
});

// POST /api/fixtures/:id/finish: full time. Either coach, or an admin. Goals still waiting are
// confirmed; disputed ones are left out. The confirmed goals become the result.
router.post('/:id/finish', coachOrAdmin, [idParam], validate, async (req, res, next) => {
  try {
    const done = await withFixture(req, res, async (client, f) => {
      await client.query(
        `UPDATE fixture_goals SET status = 'confirmed', auto_confirmed = TRUE, confirmed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP WHERE fixture_id = $1 AND status = 'pending'`,
        [f.id]
      );
      const { rows: [s] } = await client.query(
        `SELECT COALESCE(sum(points) FILTER (WHERE team_id = $2), 0)::int AS home,
                COALESCE(sum(points) FILTER (WHERE team_id = $3), 0)::int AS away
           FROM fixture_goals WHERE fixture_id = $1 AND status = 'confirmed'`,
        [f.id, f.h_id, f.a_id]
      );
      await client.query(
        `INSERT INTO scores (fixture_id, home_team_score, away_team_score) VALUES ($1, $2, $3)
         ON CONFLICT (fixture_id) DO UPDATE
           SET home_team_score = EXCLUDED.home_team_score, away_team_score = EXCLUDED.away_team_score,
               updated_at = CURRENT_TIMESTAMP`,
        [f.id, s.home, s.away]
      );
      await client.query("UPDATE fixtures SET status = 'finished', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [f.id]);
      return true;
    });
    if (!done) return;
    await notify.matchResult(done.f.id, req.user.id);
    res.json(await goalsBody(done.f.id, req.user));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
