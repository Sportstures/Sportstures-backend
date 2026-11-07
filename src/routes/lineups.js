// Match lineups, mounted under /api/fixtures.
//
// Each of the two teams in a fixture names its own starters and bench. Only that team's coach
// (or an admin) can submit it. Visibility: before the match a lineup is private to the team's
// coach, admins and the team's active players; once the match is live or finished it is public.
const express = require('express');
const { body, param } = require('express-validator');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { authenticate, requireRole } = require('../middleware/auth');
const { errorBody, FIXTURE_SELECT, FIXTURE_FROM } = require('../utils/serializers');

const router = express.Router();

const MAX_STARTERS = 25;
const MAX_BENCH = 25;

const fixtureId = param('id').isInt({ min: 1 }).withMessage('id must be a number').toInt();
const teamIdParam = param('teamId').isInt({ min: 1 }).withMessage('teamId must be a number').toInt();
const fullName = (first, last) => [first, last].filter(Boolean).join(' ') || null;

async function loadFixture(id) {
  const { rows } = await pool.query(`SELECT ${FIXTURE_SELECT} ${FIXTURE_FROM} WHERE f.id = $1`, [id]);
  return rows[0];
}

const coachOf = (f, teamId) => (teamId === f.h_id ? f.h_coach_user_id : f.a_coach_user_id);
const canManageLineup = (user, f, teamId) =>
  user.role === 'admin' || (user.role === 'coach' && coachOf(f, teamId) === user.id);
const isPublic = (f) => f.status === 'live' || f.status === 'finished';
const isClosed = (f) => f.status === 'finished' || f.status === 'cancelled';

async function isActiveMember(userId, teamId) {
  const { rows } = await pool.query(
    "SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'active'", [teamId, userId]);
  return rows.length > 0;
}

async function canView(user, f, teamId) {
  return isPublic(f) || canManageLineup(user, f, teamId) || isActiveMember(user.id, teamId);
}

async function loadLineup(fixtureIdValue, teamId) {
  const head = await pool.query(
    `SELECT l.id, l.team_id, l.formation, l.created_at, l.updated_at, t.name AS team_name
       FROM fixture_lineups l JOIN teams t ON t.id = l.team_id
      WHERE l.fixture_id = $1 AND l.team_id = $2`, [fixtureIdValue, teamId]);
  if (!head.rows[0]) return null;
  const l = head.rows[0];
  const players = await pool.query(
    `SELECT p.user_id, p.role, p.jersey_number, p.position, u.first_name, u.last_name
       FROM fixture_lineup_players p JOIN users u ON u.id = p.user_id
      WHERE p.lineup_id = $1 ORDER BY p.sort_order, p.id`, [l.id]);
  const map = (p) => ({
    userId: p.user_id, name: fullName(p.first_name, p.last_name),
    jerseyNumber: p.jersey_number, position: p.position,
  });
  return {
    team: { id: l.team_id, name: l.team_name },
    formation: l.formation,
    starters: players.rows.filter((p) => p.role === 'starter').map(map),
    bench: players.rows.filter((p) => p.role === 'bench').map(map),
    submittedAt: l.created_at,
    updatedAt: l.updated_at,
  };
}

// Loads the fixture and checks the team belongs to it and the caller manages it.
// Answers the error itself and returns undefined when something is wrong.
async function manageableFixture(req, res, action) {
  const f = await loadFixture(req.params.id);
  if (!f) { res.status(404).json(errorBody('NOT_FOUND', 'Fixture not found')); return undefined; }
  const teamId = req.params.teamId;
  if (teamId !== f.h_id && teamId !== f.a_id) {
    res.status(400).json(errorBody('TEAM_NOT_IN_FIXTURE', 'That team is not playing in this fixture'));
    return undefined;
  }
  if (!canManageLineup(req.user, f, teamId)) {
    res.status(403).json(errorBody('FORBIDDEN', `Only the team's coach can ${action} its lineup`));
    return undefined;
  }
  if (isClosed(f)) {
    res.status(409).json(errorBody('FIXTURE_CLOSED', `A ${f.status} fixture cannot take a lineup`));
    return undefined;
  }
  return f;
}

// GET /api/fixtures/:id/lineups: both teams' lineups that the caller may see.
// Each side is { teamId, submitted, lineup }; lineup is null if not submitted or not visible yet.
router.get('/:id/lineups', authenticate, [fixtureId], validate, async (req, res, next) => {
  try {
    const f = await loadFixture(req.params.id);
    if (!f) return res.status(404).json(errorBody('NOT_FOUND', 'Fixture not found'));
    const out = { fixtureId: f.id, public: isPublic(f) };
    for (const [side, teamId] of [['home', f.h_id], ['away', f.a_id]]) {
      const lineup = await loadLineup(f.id, teamId);
      const visible = lineup ? await canView(req.user, f, teamId) : false;
      out[side] = { teamId, submitted: Boolean(lineup), lineup: visible ? lineup : null };
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// PUT /api/fixtures/:id/lineups/:teamId: submit the lineup, or replace it.
// Body: { formation?, starters: [{ userId, position? }], bench?: [{ userId, position? }] }
router.put(
  '/:id/lineups/:teamId',
  authenticate,
  requireRole('coach', 'admin'),
  [fixtureId, teamIdParam,
    body('formation').optional({ values: 'falsy' }).isString().trim().isLength({ max: 30 })
      .withMessage('formation must be 30 characters or fewer'),
    body('starters').isArray({ min: 1, max: MAX_STARTERS }).withMessage(`starters must list 1 to ${MAX_STARTERS} players`),
    body('bench').optional({ values: 'null' }).isArray({ max: MAX_BENCH }).withMessage(`bench must list at most ${MAX_BENCH} players`),
    body(['starters.*.userId', 'bench.*.userId']).isInt({ min: 1 }).withMessage('each player needs a userId').toInt(),
    body(['starters.*.position', 'bench.*.position']).optional({ values: 'falsy' }).isString().trim()
      .isLength({ max: 50 }).withMessage('position must be 50 characters or fewer'),
  ],
  validate,
  async (req, res, next) => {
    let client;
    try {
      const f = await manageableFixture(req, res, 'submit');
      if (!f) return;
      const teamId = req.params.teamId;

      const all = [
        ...req.body.starters.map((p) => ({ ...p, role: 'starter' })),
        ...(req.body.bench || []).map((p) => ({ ...p, role: 'bench' })),
      ];
      const ids = all.map((p) => p.userId);
      if (new Set(ids).size !== ids.length) {
        return res.status(422).json(errorBody('DUPLICATE_PLAYER', 'A player can only appear once in a lineup'));
      }

      // Every player must be an active member of this team.
      const members = await pool.query(
        "SELECT user_id, jersey_number, position FROM team_members WHERE team_id = $1 AND status = 'active' AND user_id = ANY($2)",
        [teamId, ids]);
      const byUser = new Map(members.rows.map((m) => [m.user_id, m]));
      const missing = ids.filter((id) => !byUser.has(id));
      if (missing.length) {
        return res.status(422).json({
          error: { code: 'NOT_ON_TEAM', message: 'Every player must be an active member of the team', details: { userIds: missing } },
        });
      }

      client = await pool.connect();
      await client.query('BEGIN');
      const head = await client.query(
        `INSERT INTO fixture_lineups (fixture_id, team_id, submitted_by, formation) VALUES ($1, $2, $3, $4)
         ON CONFLICT (fixture_id, team_id) DO UPDATE
           SET submitted_by = EXCLUDED.submitted_by, formation = EXCLUDED.formation, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [f.id, teamId, req.user.id, req.body.formation || null]);
      const lineupId = head.rows[0].id;
      await client.query('DELETE FROM fixture_lineup_players WHERE lineup_id = $1', [lineupId]);
      for (const [i, p] of all.entries()) {
        const m = byUser.get(p.userId);
        await client.query(
          `INSERT INTO fixture_lineup_players (lineup_id, user_id, role, jersey_number, position, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [lineupId, p.userId, p.role, m.jersey_number, p.position || m.position || null, i]);
      }
      await client.query('COMMIT');
      res.json({ lineup: await loadLineup(f.id, teamId) });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      if (client) client.release();
    }
  }
);

// DELETE /api/fixtures/:id/lineups/:teamId: withdraw a lineup before the match is over.
router.delete(
  '/:id/lineups/:teamId',
  authenticate,
  requireRole('coach', 'admin'),
  [fixtureId, teamIdParam],
  validate,
  async (req, res, next) => {
    try {
      const f = await manageableFixture(req, res, 'withdraw');
      if (!f) return;
      const del = await pool.query('DELETE FROM fixture_lineups WHERE fixture_id = $1 AND team_id = $2', [f.id, req.params.teamId]);
      if (!del.rowCount) return res.status(404).json(errorBody('LINEUP_NOT_FOUND', 'No lineup has been submitted'));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
