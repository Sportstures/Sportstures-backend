// Match invitations: a coach invites another school's team to a match. Nothing is scheduled until
// that team's coach accepts; accepting creates the fixture. Mounted at /api/match-invitations.
const express = require('express');
const { body, query, param } = require('express-validator');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { authenticate, requireRole } = require('../middleware/auth');
const { errorBody, teamSelect, teamJoins, mapTeam } = require('../utils/serializers');
const notify = require('../utils/notifications');

const router = express.Router();
router.use(authenticate, requireRole('coach', 'admin'));

const MATCH_TYPES = ['league', 'semifinal', 'championship', 'friendly'];
const STATUSES = ['pending', 'accepted', 'declined', 'cancelled', 'expired'];

const idParam = param('id').isInt({ min: 1 }).withMessage('id must be a number').toInt();
const messageRule = (field) => body(field).optional({ values: 'null' }).isString().trim()
  .isLength({ max: 500 }).withMessage(`${field} can be at most 500 characters`);

const SELECT = `SELECT mi.*, ht.coach_id AS h_coach_user_id, awt.coach_id AS a_coach_user_id,
    ${teamSelect('ht', 'h')}, ${teamSelect('awt', 'a')},
    comp.name AS competition_name, iu.first_name AS inviter_first_name, iu.last_name AS inviter_last_name
  FROM match_invitations mi
  JOIN teams ht ON ht.id = mi.home_team_id
  JOIN teams awt ON awt.id = mi.away_team_id
  ${teamJoins('ht', 'h')}
  ${teamJoins('awt', 'a')}
  LEFT JOIN competitions comp ON comp.id = mi.competition_id
  LEFT JOIN users iu ON iu.id = mi.inviter_id`;

// A pending invitation for a match time that has passed can no longer be accepted.
const STATUS_SQL = "CASE WHEN mi.status = 'pending' AND mi.match_date <= NOW() THEN 'expired' ELSE mi.status END";

function statusOf(row) {
  return row.status === 'pending' && new Date(row.match_date) <= new Date() ? 'expired' : row.status;
}

// The coach of the invited team answers; the coach of the other team (the inviter's side) can withdraw.
const invitedCoachOf = (row) => (row.invited_team_id === row.home_team_id ? row.h_coach_user_id : row.a_coach_user_id);
const inviterCoachOf = (row) => (row.invited_team_id === row.home_team_id ? row.a_coach_user_id : row.h_coach_user_id);
const canRespond = (user, row) => user.role === 'admin' || invitedCoachOf(row) === user.id;
const canCancel = (user, row) => user.role === 'admin' || inviterCoachOf(row) === user.id || row.inviter_id === user.id;

function mapInvitation(row, user) {
  const homeTeam = mapTeam(row, 'h');
  const awayTeam = mapTeam(row, 'a');
  const invitedIsHome = row.invited_team_id === row.home_team_id;
  const status = statusOf(row);
  let direction = null;
  if (invitedCoachOf(row) === user.id) direction = 'received';
  else if (inviterCoachOf(row) === user.id || row.inviter_id === user.id) direction = 'sent';
  return {
    id: row.id,
    status,
    direction,
    matchDate: row.match_date,
    venue: row.location,
    matchType: row.match_type,
    competition: row.competition_id ? { id: row.competition_id, name: row.competition_name } : null,
    message: row.message,
    homeTeam,
    awayTeam,
    inviterTeam: invitedIsHome ? awayTeam : homeTeam,
    invitedTeam: invitedIsHome ? homeTeam : awayTeam,
    invitedBy: row.inviter_id
      ? { id: row.inviter_id, name: [row.inviter_first_name, row.inviter_last_name].filter(Boolean).join(' ') || null }
      : null,
    responseMessage: row.response_message,
    respondedAt: row.responded_at,
    fixtureId: row.fixture_id,
    canRespond: status === 'pending' && canRespond(user, row),
    canCancel: status === 'pending' && canCancel(user, row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadInvitation(id, db = pool) {
  const { rows } = await db.query(`${SELECT} WHERE mi.id = $1`, [id]);
  return rows[0];
}

const involved = (user, row) => user.role === 'admin'
  || [row.h_coach_user_id, row.a_coach_user_id, row.inviter_id].includes(user.id);

// POST /api/match-invitations
//   { opponentTeamId, matchDate, venue?, playAt?: 'home'|'away', matchType?, competitionId?, message?, teamId? }
// teamId is the inviter's own team: a coach can leave it out (their team is used); admins must send it.
router.post(
  '/',
  [
    body('opponentTeamId').isInt({ min: 1 }).withMessage('opponentTeamId is required').toInt(),
    body('teamId').optional({ values: 'null' }).isInt({ min: 1 }).withMessage('teamId must be a number').toInt(),
    body('matchDate').isISO8601({ strict: true }).withMessage('matchDate must be an ISO 8601 date-time')
      .matches(/(Z|[+-]\d{2}:?\d{2})$/).withMessage('matchDate must include a time zone, e.g. 2026-11-06T18:00:00+02:00'),
    body('venue').optional({ values: 'falsy' }).isString().trim().isLength({ max: 255 }),
    body('playAt').optional().isIn(['home', 'away']).withMessage('playAt must be home or away'),
    body('matchType').optional().isIn(MATCH_TYPES).withMessage(`matchType must be one of: ${MATCH_TYPES.join(', ')}`),
    body('competitionId').optional({ values: 'null' }).isInt({ min: 1 }).toInt(),
    messageRule('message'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const b = req.body;
      if (new Date(b.matchDate) <= new Date()) {
        return res.status(400).json(errorBody('MATCH_IN_PAST', 'The match must be in the future'));
      }

      // The inviter's own team.
      let teamId = b.teamId;
      if (!teamId) {
        if (req.user.role === 'admin') return res.status(400).json(errorBody('TEAM_REQUIRED', 'Admins must send teamId'));
        const { rows: [own] } = await pool.query('SELECT id FROM teams WHERE coach_id = $1 ORDER BY id LIMIT 1', [req.user.id]);
        if (!own) return res.status(400).json(errorBody('NO_TEAM', 'You need a team before you can invite others to a match'));
        teamId = own.id;
      }
      if (teamId === b.opponentTeamId) {
        return res.status(400).json(errorBody('SAME_TEAM', 'A team cannot play itself'));
      }

      const { rows: teams } = await pool.query('SELECT id, sport_id, coach_id FROM teams WHERE id IN ($1, $2)', [teamId, b.opponentTeamId]);
      const mine = teams.find((x) => x.id === teamId);
      const opponent = teams.find((x) => x.id === b.opponentTeamId);
      if (!mine) return res.status(404).json(errorBody('NOT_FOUND', 'Your team was not found'));
      if (!opponent) return res.status(404).json(errorBody('NOT_FOUND', 'The opponent team was not found'));
      if (req.user.role !== 'admin' && mine.coach_id !== req.user.id) {
        return res.status(403).json(errorBody('FORBIDDEN', 'You can only send invitations for a team you coach'));
      }
      if (mine.sport_id && opponent.sport_id && mine.sport_id !== opponent.sport_id) {
        return res.status(400).json(errorBody('SPORT_MISMATCH', 'Both teams must play the same sport'));
      }
      if (!opponent.coach_id) {
        return res.status(409).json(errorBody('OPPONENT_HAS_NO_COACH',
          'That team has no coach on Sportstures yet to accept. Invite their coach to join first (POST /api/invitations)'));
      }
      if (b.competitionId) {
        const comp = await pool.query('SELECT 1 FROM competitions WHERE id = $1', [b.competitionId]);
        if (!comp.rows[0]) return res.status(400).json(errorBody('UNKNOWN_COMPETITION', 'Unknown competitionId'));
      }

      const home = (b.playAt || 'home') === 'home';
      let inserted;
      try {
        inserted = await pool.query(
          `INSERT INTO match_invitations
             (inviter_id, home_team_id, away_team_id, invited_team_id, match_date, location, competition_id, match_type, message)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [req.user.id, home ? teamId : opponent.id, home ? opponent.id : teamId, opponent.id, b.matchDate,
            b.venue || null, b.competitionId || null, b.matchType || 'friendly', b.message || null]
        );
      } catch (err) {
        if (err.code === '23505') {
          return res.status(409).json(errorBody('INVITATION_EXISTS', 'These teams already have an open invitation for that time'));
        }
        throw err;
      }

      const row = await loadInvitation(inserted.rows[0].id);
      const invitation = mapInvitation(row, req.user);
      await notify.matchInvitation('match_invitation_received', invitation, opponent.coach_id, req.user.id);
      res.status(201).json({ invitation });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/match-invitations?direction=received|sent&status=pending|accepted|declined|cancelled|expired&teamId&limit&offset
// A coach sees invitations for the teams they coach. Admins see all (or one team's, with teamId).
router.get(
  '/',
  [
    query('direction').optional().isIn(['received', 'sent']).withMessage('direction must be received or sent'),
    query('status').optional().isIn(STATUSES).withMessage(`status must be one of: ${STATUSES.join(', ')}`),
    query('teamId').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { direction, status, teamId } = req.query;
      const limit = req.query.limit || 50;
      const offset = req.query.offset || 0;
      const where = [];
      const params = [];
      const p = (value) => { params.push(value); return `$${params.length}`; };

      // "My" teams: the one asked for, or every team this coach coaches. Admins without teamId: all teams.
      let myTeams = null;
      if (teamId) {
        if (req.user.role !== 'admin') {
          const own = await pool.query('SELECT 1 FROM teams WHERE id = $1 AND coach_id = $2', [teamId, req.user.id]);
          if (!own.rows[0]) return res.status(403).json(errorBody('FORBIDDEN', 'You can only see invitations for a team you coach'));
        }
        myTeams = `(${p(teamId)}::int)`;
      } else if (req.user.role !== 'admin') {
        myTeams = `(SELECT id FROM teams WHERE coach_id = ${p(req.user.id)})`;
      }

      if (myTeams) {
        const other = 'CASE WHEN mi.invited_team_id = mi.home_team_id THEN mi.away_team_id ELSE mi.home_team_id END';
        if (direction === 'received') where.push(`mi.invited_team_id IN ${myTeams}`);
        else if (direction === 'sent') where.push(`${other} IN ${myTeams}`);
        else where.push(`(mi.home_team_id IN ${myTeams} OR mi.away_team_id IN ${myTeams})`);
      }
      if (status) where.push(`${STATUS_SQL} = ${p(status)}`);

      const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (await pool.query(`SELECT count(*)::int AS n FROM match_invitations mi ${filter}`, params)).rows[0].n;
      // Open invitations first, soonest match first; then the rest, newest first.
      const { rows } = await pool.query(
        `${SELECT} ${filter}
         ORDER BY (${STATUS_SQL} = 'pending') DESC,
                  CASE WHEN ${STATUS_SQL} = 'pending' THEN mi.match_date END ASC,
                  mi.updated_at DESC, mi.id DESC
         LIMIT ${p(limit)} OFFSET ${p(offset)}`,
        params
      );
      res.json({ invitations: rows.map((r) => mapInvitation(r, req.user)), total, limit, offset });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:id', [idParam], validate, async (req, res, next) => {
  try {
    const row = await loadInvitation(req.params.id);
    if (!row || !involved(req.user, row)) return res.status(404).json(errorBody('NOT_FOUND', 'Invitation not found'));
    res.json({ invitation: mapInvitation(row, req.user) });
  } catch (err) {
    next(err);
  }
});

// Locks the invitation, checks it is still open and that this person may act, then runs `change`
// in the same transaction. Returns the updated invitation, or sends the error and returns null.
async function respond(req, res, allowed, forbiddenMessage, change) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT id FROM match_invitations WHERE id = $1 FOR UPDATE', [req.params.id]);
    const row = locked.rows[0] && await loadInvitation(req.params.id, client);
    if (!row || !involved(req.user, row)) {
      await client.query('ROLLBACK');
      res.status(404).json(errorBody('NOT_FOUND', 'Invitation not found'));
      return null;
    }
    if (!allowed(req.user, row)) {
      await client.query('ROLLBACK');
      res.status(403).json(errorBody('FORBIDDEN', forbiddenMessage));
      return null;
    }
    const status = statusOf(row);
    if (status !== 'pending') {
      await client.query('ROLLBACK');
      res.status(409).json(errorBody('INVITATION_CLOSED', `This invitation is already ${status}`));
      return null;
    }
    await change(client, row);
    await client.query('COMMIT');
    return { before: row, after: await loadInvitation(row.id) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// POST /api/match-invitations/:id/accept  { message? }: the invited team's coach. Creates the fixture.
router.post('/:id/accept', [idParam, messageRule('message')], validate, async (req, res, next) => {
  try {
    const done = await respond(req, res, canRespond, 'Only the invited team\'s coach can accept', async (client, row) => {
      const fixture = await client.query(
        `INSERT INTO fixtures (home_team_id, away_team_id, match_date, location, competition_id, match_type)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [row.home_team_id, row.away_team_id, row.match_date, row.location, row.competition_id, row.match_type]
      );
      await client.query(
        `UPDATE match_invitations
            SET status = 'accepted', fixture_id = $2, response_message = $3, responded_by = $4,
                responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [row.id, fixture.rows[0].id, req.body.message || null, req.user.id]
      );
    });
    if (!done) return;
    const invitation = mapInvitation(done.after, req.user);
    await notify.matchInvitation('match_invitation_accepted', invitation, inviterCoachOf(done.after), req.user.id);
    // The new match reaches players and followers like any scheduled fixture.
    await notify.fixtureScheduled(invitation.fixtureId, req.user.id);
    res.json({ invitation });
  } catch (err) {
    next(err);
  }
});

// POST /api/match-invitations/:id/decline  { message? }: the invited team's coach.
router.post('/:id/decline', [idParam, messageRule('message')], validate, async (req, res, next) => {
  try {
    const done = await respond(req, res, canRespond, 'Only the invited team\'s coach can decline', (client, row) => client.query(
      `UPDATE match_invitations
          SET status = 'declined', response_message = $2, responded_by = $3,
              responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [row.id, req.body.message || null, req.user.id]
    ));
    if (!done) return;
    const invitation = mapInvitation(done.after, req.user);
    await notify.matchInvitation('match_invitation_declined', invitation, inviterCoachOf(done.after), req.user.id);
    res.json({ invitation });
  } catch (err) {
    next(err);
  }
});

// POST /api/match-invitations/:id/cancel: the inviting side withdraws an invitation that is still open.
router.post('/:id/cancel', [idParam], validate, async (req, res, next) => {
  try {
    const done = await respond(req, res, canCancel, 'Only the team that sent the invitation can withdraw it', (client, row) => client.query(
      "UPDATE match_invitations SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [row.id]
    ));
    if (!done) return;
    const invitation = mapInvitation(done.after, req.user);
    await notify.matchInvitation('match_invitation_cancelled', invitation, invitedCoachOf(done.after), req.user.id);
    res.json({ invitation });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
