// Team rosters, mounted under /api/teams.
//
// Privacy: players are school children, so a roster is only visible to the team's coach,
// admins and the team's own active players. Everyone else only sees a player COUNT on the team.
const express = require('express');
const { body, query, param } = require('express-validator');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { authenticate, requireRole } = require('../middleware/auth');
const { errorBody } = require('../utils/serializers');

const router = express.Router();

const teamId = param('id').isInt({ min: 1 }).withMessage('id must be a number').toInt();
const userIdParam = param('userId').isInt({ min: 1 }).withMessage('userId must be a number').toInt();
const jerseyField = (location) => location('jerseyNumber').optional({ values: 'null' })
  .isInt({ min: 0, max: 999 }).withMessage('jerseyNumber must be a number from 0 to 999').toInt();
const positionField = (location) => location('position').optional({ values: 'falsy' })
  .isString().trim().isLength({ max: 50 }).withMessage('position must be 50 characters or fewer');

const fullName = (first, last) => [first, last].filter(Boolean).join(' ') || null;

async function loadTeam(id) {
  const { rows } = await pool.query(
    'SELECT id, name, school_id, sport_id, coach_id AS coach_user_id FROM teams WHERE id = $1',
    [id]
  );
  return rows[0];
}

const isTeamManager = (user, team) =>
  user.role === 'admin' || (user.role === 'coach' && team.coach_user_id === user.id);

async function isActiveMember(userId, id) {
  const { rows } = await pool.query(
    "SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'active'",
    [id, userId]
  );
  return rows.length > 0;
}

// Loads the team or answers 404. Returns undefined when it has already responded.
async function teamOr404(req, res) {
  const team = await loadTeam(req.params.id);
  if (!team) res.status(404).json(errorBody('NOT_FOUND', 'Team not found'));
  return team;
}

const MEMBER_SELECT = `SELECT tm.team_id, tm.user_id, tm.status, tm.jersey_number, tm.position,
    tm.joined_at, tm.created_at, u.first_name, u.last_name,
    lp.grade, lp.class_name
  FROM team_members tm
  JOIN users u ON u.id = tm.user_id
  LEFT JOIN learner_profiles lp ON lp.user_id = tm.user_id`;

function mapMember(r) {
  return {
    userId: r.user_id,
    name: fullName(r.first_name, r.last_name),
    firstName: r.first_name,
    lastName: r.last_name,
    status: r.status,
    jerseyNumber: r.jersey_number,
    position: r.position,
    grade: r.grade ?? null,
    className: r.class_name ?? null,
    joinedAt: r.joined_at,
    requestedAt: r.created_at,
  };
}

async function loadMember(id, userId) {
  const { rows } = await pool.query(`${MEMBER_SELECT} WHERE tm.team_id = $1 AND tm.user_id = $2`, [id, userId]);
  return rows[0];
}

const jerseyTaken = () => errorBody('JERSEY_TAKEN', 'Another player on this team already has that number');

// ------------------------------------------------------------------ the roster

// GET /api/teams/:id/roster?status=active|pending
router.get(
  '/:id/roster',
  authenticate,
  [teamId, query('status').optional().isIn(['active', 'pending'])],
  validate,
  async (req, res, next) => {
    try {
      const team = await teamOr404(req, res);
      if (!team) return;
      const status = req.query.status || 'active';
      const manager = isTeamManager(req.user, team);

      if (status === 'pending' && !manager) {
        return res.status(403).json(errorBody('FORBIDDEN', 'Only the team\'s coach can see join requests'));
      }
      if (!manager && !(await isActiveMember(req.user.id, team.id))) {
        return res.status(403).json(errorBody('FORBIDDEN', 'Only the team\'s coach and players can see the roster'));
      }

      const { rows } = await pool.query(
        `${MEMBER_SELECT} WHERE tm.team_id = $1 AND tm.status = $2
         ORDER BY tm.jersey_number NULLS LAST, u.last_name, u.first_name, tm.user_id`,
        [team.id, status]
      );
      res.json({ team: { id: team.id, name: team.name }, status, count: rows.length, roster: rows.map(mapMember) });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/teams/:id/candidates?q=: learners from the team's school who could be added (coach or admin).
router.get(
  '/:id/candidates',
  authenticate,
  requireRole('coach', 'admin'),
  [teamId, query('q').optional().isString().trim().isLength({ max: 100 }), query('limit').optional().isInt({ min: 1, max: 100 }).toInt()],
  validate,
  async (req, res, next) => {
    try {
      const team = await teamOr404(req, res);
      if (!team) return;
      if (!isTeamManager(req.user, team)) {
        return res.status(403).json(errorBody('FORBIDDEN', 'You can only manage the roster of your own team'));
      }
      if (!team.school_id) {
        return res.status(409).json(errorBody('TEAM_SCHOOL_REQUIRED', 'Set the team\'s school before adding players'));
      }

      const params = [team.id, team.school_id];
      let search = '';
      if (req.query.q) {
        params.push(`%${req.query.q}%`);
        search = `AND (u.first_name || ' ' || u.last_name) ILIKE $${params.length}`;
      }
      params.push(req.query.limit || 50);

      const { rows } = await pool.query(
        `SELECT u.id, u.first_name, u.last_name, lp.grade, lp.class_name,
                sp.name AS declared_sport, lp.team_name AS declared_team, lp.jersey_number AS declared_jersey
           FROM users u
           JOIN roles r ON r.id = u.role_id AND r.name = 'learner'
           JOIN learner_profiles lp ON lp.user_id = u.id AND lp.school_id = $2
           LEFT JOIN sports sp ON sp.id = lp.sport_id
          WHERE u.email_verified = TRUE
            AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = $1 AND tm.user_id = u.id)
            ${search}
          ORDER BY u.last_name, u.first_name, u.id
          LIMIT $${params.length}`,
        params
      );
      res.json({
        candidates: rows.map((r) => ({
          userId: r.id,
          name: fullName(r.first_name, r.last_name),
          grade: r.grade,
          className: r.class_name,
          declaredSport: r.declared_sport,
          declaredTeamName: r.declared_team,
          declaredJerseyNumber: r.declared_jersey,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/teams/:id/roster: the coach adds a learner straight onto the team (or approves their request).
router.post(
  '/:id/roster',
  authenticate,
  requireRole('coach', 'admin'),
  [teamId, body('userId').isInt({ min: 1 }).withMessage('userId is required').toInt(), jerseyField(body), positionField(body)],
  validate,
  async (req, res, next) => {
    try {
      const team = await teamOr404(req, res);
      if (!team) return;
      if (!isTeamManager(req.user, team)) {
        return res.status(403).json(errorBody('FORBIDDEN', 'You can only manage the roster of your own team'));
      }

      const learner = await pool.query(
        `SELECT u.id, r.name AS role, lp.school_id
           FROM users u JOIN roles r ON r.id = u.role_id
           LEFT JOIN learner_profiles lp ON lp.user_id = u.id
          WHERE u.id = $1`,
        [req.body.userId]
      );
      const target = learner.rows[0];
      if (!target) return res.status(404).json(errorBody('NOT_FOUND', 'User not found'));
      if (target.role !== 'learner') {
        return res.status(400).json(errorBody('NOT_A_LEARNER', 'Only learners can be added to a team roster'));
      }
      // Coaches can only add learners from the team's own school (admins can add anyone).
      if (req.user.role !== 'admin' && team.school_id && target.school_id !== team.school_id) {
        return res.status(409).json(errorBody('SCHOOL_MISMATCH', 'That learner is not at this team\'s school'));
      }

      const existing = await pool.query('SELECT status FROM team_members WHERE team_id = $1 AND user_id = $2', [team.id, target.id]);
      if (existing.rows[0] && existing.rows[0].status === 'active') {
        return res.status(409).json(errorBody('ALREADY_MEMBER', 'That learner is already on this team'));
      }

      try {
        // A pending join request is simply approved; otherwise the learner is added.
        await pool.query(
          `INSERT INTO team_members (team_id, user_id, status, jersey_number, position, joined_at)
           VALUES ($1, $2, 'active', $3, $4, CURRENT_TIMESTAMP)
           ON CONFLICT (team_id, user_id) DO UPDATE
             SET status = 'active',
                 jersey_number = COALESCE(EXCLUDED.jersey_number, team_members.jersey_number),
                 position = COALESCE(EXCLUDED.position, team_members.position),
                 joined_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
          [team.id, target.id, req.body.jerseyNumber ?? null, req.body.position || null]
        );
      } catch (err) {
        if (err.code === '23505') return res.status(409).json(jerseyTaken());
        throw err;
      }
      const member = await loadMember(team.id, target.id);
      res.status(existing.rows[0] ? 200 : 201).json({ member: mapMember(member) });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/teams/:id/roster/:userId: approve a request, change the number or position.
router.patch(
  '/:id/roster/:userId',
  authenticate,
  requireRole('coach', 'admin'),
  [teamId, userIdParam, jerseyField(body), positionField(body), body('status').optional().isIn(['active']).withMessage('status can only be set to active')],
  validate,
  async (req, res, next) => {
    try {
      const team = await teamOr404(req, res);
      if (!team) return;
      if (!isTeamManager(req.user, team)) {
        return res.status(403).json(errorBody('FORBIDDEN', 'You can only manage the roster of your own team'));
      }
      const member = await loadMember(team.id, req.params.userId);
      if (!member) return res.status(404).json(errorBody('NOT_FOUND', 'That learner is not on this team'));

      const sets = [];
      const params = [];
      const set = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
      if (req.body.jerseyNumber !== undefined) set('jersey_number', req.body.jerseyNumber);
      if (req.body.position !== undefined) set('position', req.body.position || null);
      if (req.body.status === 'active' && member.status !== 'active') {
        sets.push('status = \'active\'', 'joined_at = CURRENT_TIMESTAMP');
      }
      if (sets.length) {
        sets.push('updated_at = CURRENT_TIMESTAMP');
        params.push(team.id, req.params.userId);
        try {
          await pool.query(
            `UPDATE team_members SET ${sets.join(', ')} WHERE team_id = $${params.length - 1} AND user_id = $${params.length}`,
            params
          );
        } catch (err) {
          if (err.code === '23505') return res.status(409).json(jerseyTaken());
          throw err;
        }
      }
      res.json({ member: mapMember(await loadMember(team.id, req.params.userId)) });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/teams/:id/roster/:userId: remove a player, or reject a join request.
router.delete(
  '/:id/roster/:userId',
  authenticate,
  requireRole('coach', 'admin'),
  [teamId, userIdParam],
  validate,
  async (req, res, next) => {
    try {
      const team = await teamOr404(req, res);
      if (!team) return;
      if (!isTeamManager(req.user, team)) {
        return res.status(403).json(errorBody('FORBIDDEN', 'You can only manage the roster of your own team'));
      }
      const removed = await pool.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [team.id, req.params.userId]);
      if (!removed.rowCount) return res.status(404).json(errorBody('NOT_FOUND', 'That learner is not on this team'));
      res.json({ message: 'Removed from the team' });
    } catch (err) {
      next(err);
    }
  }
);

// ------------------------------------------------------------------ learners joining and leaving

// POST /api/teams/:id/join-requests: a learner asks to join; the coach approves.
router.post(
  '/:id/join-requests',
  authenticate,
  [teamId, jerseyField(body)],
  validate,
  async (req, res, next) => {
    try {
      if (req.user.role !== 'learner') {
        return res.status(403).json(errorBody('FORBIDDEN', 'Only learners can ask to join a team'));
      }
      const team = await teamOr404(req, res);
      if (!team) return;

      const existing = await pool.query('SELECT status FROM team_members WHERE team_id = $1 AND user_id = $2', [team.id, req.user.id]);
      if (existing.rows[0]) {
        return existing.rows[0].status === 'active'
          ? res.status(409).json(errorBody('ALREADY_MEMBER', 'You are already on this team'))
          : res.status(409).json(errorBody('REQUEST_PENDING', 'You have already asked to join this team'));
      }

      await pool.query(
        "INSERT INTO team_members (team_id, user_id, status, jersey_number) VALUES ($1, $2, 'pending', $3)",
        [team.id, req.user.id, req.body.jerseyNumber ?? null]
      );
      res.status(201).json({ member: mapMember(await loadMember(team.id, req.user.id)) });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/teams/:id/membership: leave a team, or cancel your own request.
router.delete('/:id/membership', authenticate, [teamId], validate, async (req, res, next) => {
  try {
    const removed = await pool.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!removed.rowCount) return res.status(404).json(errorBody('NOT_FOUND', 'You are not on this team'));
    res.json({ message: 'You have left the team' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
