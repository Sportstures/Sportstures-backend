// The in-app notifications inbox (GET /api/me/notifications). Learners get match, team and lineup
// news; coaches get match invitations from other schools.
//
// Routes call the notify* functions after their change is saved. Those never throw: a failed
// notification is logged and the request still succeeds.
const pool = require('../../db/config');
const { FIXTURE_SELECT, FIXTURE_FROM, mapFixture } = require('./serializers');

// Each setting (a toggle in the app) and the notification types it covers.
const CATEGORIES = {
  matchResults: { column: 'match_results', types: ['match_result'] },
  fixtureChanges: {
    column: 'fixture_changes',
    types: ['fixture_scheduled', 'fixture_rescheduled', 'fixture_postponed', 'fixture_cancelled'],
  },
  teamMembership: {
    column: 'team_membership',
    types: ['join_approved', 'join_declined', 'squad_added', 'squad_removed'],
  },
  lineupSelection: { column: 'lineup_selection', types: ['lineup_selected'] },
  // For coaches: another school invites their team to a match, or answers their invitation.
  matchInvitations: {
    column: 'match_invitations',
    roles: ['coach', 'admin'],
    types: ['match_invitation_received', 'match_invitation_accepted', 'match_invitation_declined', 'match_invitation_cancelled'],
  },
  // For coaches during a live match: the other coach added a goal to confirm, or disputed one of theirs.
  goalConfirmations: {
    column: 'goal_confirmations',
    roles: ['coach', 'admin'],
    types: ['goal_confirmation_needed', 'goal_disputed'],
  },
};
const CATEGORY_OF = Object.fromEntries(
  Object.entries(CATEGORIES).flatMap(([key, c]) => c.types.map((type) => [type, key]))
);

// Times in messages are South African, like the rest of the app: "Sat 22 Nov, 10:00".
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Johannesburg', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function when(date) {
  const p = Object.fromEntries(timeFormat.formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}`;
}

const matchup = (f) => `${f.homeTeam.name} v ${f.awayTeam.name}`;

async function loadFixture(id) {
  const { rows } = await pool.query(`SELECT ${FIXTURE_SELECT} ${FIXTURE_FROM} WHERE f.id = $1`, [id]);
  return rows[0] ? mapFixture(rows[0]) : null;
}

const fixtureData = (f) => ({
  fixtureId: f.id,
  homeTeamId: f.homeTeam.id,
  awayTeamId: f.awayTeam.id,
  competitionId: f.competition ? f.competition.id : null,
});

// Saves one notification for every listed person whose setting for this type is on. Only learners
// receive them, unless the category names other roles.
// recipients is a SQL subquery returning user ids (with $1, $2... from recipientParams), or a list of ids.
async function insert(type, { title, body, data }, recipients, recipientParams = [], exceptUserId = null) {
  const { column, roles = ['learner'] } = CATEGORIES[CATEGORY_OF[type]];
  const list = Array.isArray(recipients);
  const params = list ? [recipients] : [...recipientParams];
  const source = list ? 'SELECT unnest($1::int[])' : recipients;
  params.push(roles, type, title, body || null, JSON.stringify(data || {}), exceptUserId);
  const n = params.length;
  const { rowCount } = await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, data)
     SELECT u.id, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}::jsonb
       FROM users u
       JOIN roles r ON r.id = u.role_id AND r.name = ANY($${n - 5}::text[])
       LEFT JOIN notification_settings ns ON ns.user_id = u.id
      WHERE u.id IN (${source})
        AND u.id IS DISTINCT FROM $${n}::int
        AND COALESCE(ns.${column}, TRUE)`,
    params
  );
  return rowCount;
}

// Learners who care about a fixture: players on either team, and anyone who favourites either team,
// follows either school or follows the competition.
const FIXTURE_AUDIENCE = `
  SELECT user_id FROM team_members WHERE status = 'active' AND team_id = ANY($1::int[])
  UNION SELECT user_id FROM user_favorite_teams WHERE team_id = ANY($1::int[])
  UNION SELECT user_id FROM user_followed_schools WHERE school_id = ANY($2::int[])
  UNION SELECT user_id FROM competition_follows WHERE competition_id = $3`;

async function toFixtureAudience(f, type, message, exceptUserId) {
  const schools = [f.homeTeam.school, f.awayTeam.school].filter(Boolean).map((s) => s.id);
  return insert(type, { ...message, data: fixtureData(f) }, FIXTURE_AUDIENCE,
    [[f.homeTeam.id, f.awayTeam.id], schools, f.competition ? f.competition.id : null], exceptUserId);
}

// Logs instead of throwing, so a notification problem never fails the request that caused it.
const safely = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    console.error('Notification failed:', err.message);
    return 0;
  }
};

// ------------------------------------------------------------------ fixtures

const fixtureScheduled = safely(async (fixtureId, actorId) => {
  const f = await loadFixture(fixtureId);
  if (!f) return 0;
  return toFixtureAudience(f, 'fixture_scheduled', {
    title: `New match: ${matchup(f)}`,
    body: [when(f.matchDate), f.venue, f.competition && f.competition.name].filter(Boolean).join(' · '),
  }, actorId);
});

// before: the fixture as it was (from mapFixture). Sends one notification for the most important change.
const fixtureChanged = safely(async (before, actorId) => {
  const f = await loadFixture(before.id);
  if (!f) return 0;
  if (f.status !== before.status && f.status === 'cancelled') {
    return toFixtureAudience(f, 'fixture_cancelled', { title: `Cancelled: ${matchup(f)}`, body: `Was set for ${when(before.matchDate)}` }, actorId);
  }
  if (f.status !== before.status && f.status === 'postponed') {
    return toFixtureAudience(f, 'fixture_postponed', { title: `Postponed: ${matchup(f)}`, body: `Was set for ${when(before.matchDate)}` }, actorId);
  }
  const moved = new Date(f.matchDate).getTime() !== new Date(before.matchDate).getTime();
  const newVenue = (f.venue || null) !== (before.venue || null);
  const backOn = before.status !== 'scheduled' && f.status === 'scheduled';
  if (!moved && !newVenue && !backOn) return 0;
  return toFixtureAudience(f, 'fixture_rescheduled', {
    title: `${backOn ? 'Back on' : 'Match updated'}: ${matchup(f)}`,
    body: [when(f.matchDate), f.venue].filter(Boolean).join(' · '),
  }, actorId);
});

const matchResult = safely(async (fixtureId, actorId, { corrected = false } = {}) => {
  const f = await loadFixture(fixtureId);
  if (!f || !f.score) return 0;
  return toFixtureAudience(f, 'match_result', {
    title: `${corrected ? 'Result corrected' : 'Full time'}: ${f.homeTeam.name} ${f.score.home} - ${f.score.away} ${f.awayTeam.name}`,
    body: f.competition ? f.competition.name : 'Friendly',
  }, actorId);
});

// ------------------------------------------------------------------ team membership

const MEMBERSHIP = {
  join_approved: (team) => ({ title: `You're in: ${team.name}`, body: 'Your request to join was approved.' }),
  join_declined: (team) => ({ title: `Join request declined: ${team.name}`, body: 'The coach declined your request to join.' }),
  squad_added: (team) => ({ title: `Added to ${team.name}`, body: 'Your coach added you to the squad.' }),
  squad_removed: (team) => ({ title: `Removed from ${team.name}`, body: 'Your coach removed you from the squad.' }),
};

const membership = safely(async (type, teamId, userId) => {
  const { rows: [team] } = await pool.query('SELECT id, name FROM teams WHERE id = $1', [teamId]);
  if (!team) return 0;
  return insert(type, { ...MEMBERSHIP[type](team), data: { teamId: team.id } }, [userId]);
});

// ------------------------------------------------------------------ lineups

// players: [{ userId, role: 'starter'|'bench' }]. previous: the same for the lineup it replaced, so a
// resubmitted lineup only notifies players who are new to it or moved between starting and the bench.
const lineupSelected = safely(async (fixtureId, teamId, players, previous = []) => {
  const f = await loadFixture(fixtureId);
  if (!f) return 0;
  const team = f.homeTeam.id === teamId ? f.homeTeam : f.awayTeam;
  const before = new Map(previous.map((p) => [p.userId, p.role]));
  let sent = 0;
  for (const role of ['starter', 'bench']) {
    const ids = players.filter((p) => p.role === role && before.get(p.userId) !== role).map((p) => p.userId);
    if (!ids.length) continue;
    sent += await insert('lineup_selected', {
      title: role === 'starter' ? `You're starting: ${matchup(f)}` : `You're on the bench: ${matchup(f)}`,
      body: [team.name, when(f.matchDate), f.venue].filter(Boolean).join(' · '),
      data: { ...fixtureData(f), teamId: team.id, role },
    }, ids);
  }
  return sent;
});

// ------------------------------------------------------------------ match invitations (for coaches)

const INVITATION_MESSAGES = {
  match_invitation_received: (inv) => ({
    title: `Match invitation: ${matchup(inv)}`,
    body: [`From ${inv.inviterTeam.name}`, when(inv.matchDate), inv.venue].filter(Boolean).join(' · '),
  }),
  match_invitation_accepted: (inv) => ({
    title: `Accepted: ${matchup(inv)}`,
    body: [`${inv.invitedTeam.name} accepted`, when(inv.matchDate)].join(' · '),
  }),
  match_invitation_declined: (inv) => ({
    title: `Declined: ${matchup(inv)}`,
    body: [`${inv.invitedTeam.name} declined`, inv.responseMessage].filter(Boolean).join(' · '),
  }),
  match_invitation_cancelled: (inv) => ({
    title: `Invitation withdrawn: ${matchup(inv)}`,
    body: [`${inv.inviterTeam.name} withdrew it`, when(inv.matchDate)].join(' · '),
  }),
};

// inv: a match invitation as the API returns it. Goes to one side's coach; the person who acted
// never gets their own notification.
const matchInvitation = safely(async (type, inv, recipientUserId, actorId) => {
  if (!recipientUserId) return 0;
  return insert(type, {
    ...INVITATION_MESSAGES[type](inv),
    data: { matchInvitationId: inv.id, fixtureId: inv.fixtureId, homeTeamId: inv.homeTeam.id, awayTeamId: inv.awayTeam.id },
  }, [recipientUserId], [], actorId);
});

// ------------------------------------------------------------------ live scoring (for coaches)

// goal: as GET /api/fixtures/:id/goals returns it; f: the fixture (from mapFixture).
const GOAL_MESSAGES = {
  goal_confirmation_needed: (goal, f) => ({
    title: `Confirm goal: ${goal.team.name}${goal.minute !== null ? ` (${goal.minute}')` : ''}`,
    body: [matchup(f), goal.player && goal.player.name, goal.points > 1 ? `${goal.points} points` : null].filter(Boolean).join(' · '),
  }),
  goal_disputed: (goal, f) => ({
    title: `Goal disputed: ${goal.team.name}${goal.minute !== null ? ` (${goal.minute}')` : ''}`,
    body: [matchup(f), goal.disputeReason].filter(Boolean).join(' · '),
  }),
};

const goal = safely(async (type, goalObject, fixtureId, recipientUserId, actorId) => {
  if (!recipientUserId) return 0;
  const f = await loadFixture(fixtureId);
  if (!f) return 0;
  return insert(type, {
    ...GOAL_MESSAGES[type](goalObject, f),
    data: { ...fixtureData(f), goalId: goalObject.id, teamId: goalObject.team.id },
  }, [recipientUserId], [], actorId);
});

module.exports = {
  CATEGORIES, CATEGORY_OF, fixtureScheduled, fixtureChanged, matchResult, membership, lineupSelected, matchInvitation, goal,
};
