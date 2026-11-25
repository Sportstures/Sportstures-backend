// Match invitations: a coach invites another school's team; the fixture exists only once they accept.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, makeAdmin, learnerPayload } = require('./helpers/setup');

let t;
let jeppe, greenwood, kingEd, football, noCoachTeamId, learner, admin;

const inDays = (days) => new Date(Date.now() + days * 86400000).toISOString().replace(/\.\d+Z$/, 'Z');
const invite = (coach, body) => t.api('POST', '/api/match-invitations', body, coach.token);
const act = (coach, id, action, body = {}) => t.api('POST', `/api/match-invitations/${id}/${action}`, body, coach.token);
const inbox = async (coach) => (await t.api('GET', '/api/me/notifications', undefined, coach.token)).body.notifications;
const teamOf = async (coach) => (await t.api('GET', '/api/teams?mine=true', undefined, coach.token)).body.teams[0];

before(async () => {
  t = await startTestApp();
  const basketball = (school, email) => signUpCoach(t, { email, school, team: { name: `${school} Basketball`, level: '1st_team', sport: 'Basketball' } });
  jeppe = await basketball('Jeppe High', 'jeppe@example.com');
  greenwood = await basketball('Greenwood', 'greenwood@example.com');
  kingEd = await basketball('King Edward', 'kinged@example.com');
  football = await signUpCoach(t, { email: 'football@example.com', school: 'Parktown', team: { name: 'Parktown Football', level: 'u16', sport: 'Football' } });
  for (const c of [jeppe, greenwood, kingEd, football]) c.team = await teamOf(c);

  learner = await signUpLearner(t, learnerPayload({ email: 'learner@example.com' }));
  admin = await signUpLearner(t, learnerPayload({ email: 'admin@example.com' }));
  await makeAdmin(t, 'admin@example.com');
  const sports = (await t.api('GET', '/api/sports')).body.sports;
  const created = await t.api('POST', '/api/teams', {
    name: 'Orphans Basketball', sportId: sports.find((s) => s.name === 'Basketball').id, school: 'Orphan High',
  }, admin.token);
  noCoachTeamId = created.body.team.id;
});
after(async () => { await t.stop(); });

test('a coach invites another school; nothing is scheduled until they accept', async () => {
  const res = await invite(jeppe, {
    opponentTeamId: greenwood.team.id, matchDate: inDays(7), venue: 'Jeppe Court', message: 'Friendly before the league?',
  });
  assert.equal(res.status, 201);
  const inv = res.body.invitation;
  assert.equal(inv.status, 'pending');
  assert.equal(inv.direction, 'sent');
  assert.equal(inv.matchType, 'friendly');
  assert.equal(inv.homeTeam.id, jeppe.team.id, 'the inviter hosts by default');
  assert.equal(inv.inviterTeam.id, jeppe.team.id);
  assert.equal(inv.invitedTeam.id, greenwood.team.id);
  assert.equal(inv.invitedTeam.school.name, 'Greenwood');
  assert.equal(inv.invitedBy.id, jeppe.user.id);
  assert.equal(inv.fixtureId, null);
  assert.equal(inv.canCancel, true);
  assert.equal(inv.canRespond, false);

  const fixtures = await t.api('GET', `/api/fixtures?teamId=${greenwood.team.id}`);
  assert.equal(fixtures.body.fixtures.length, 0, 'no fixture yet');

  // The invited coach sees it in their list and their inbox, and can answer it.
  const received = await t.api('GET', '/api/match-invitations?direction=received', undefined, greenwood.token);
  assert.deepEqual(received.body.invitations.map((x) => x.id), [inv.id]);
  assert.equal(received.body.invitations[0].direction, 'received');
  assert.equal(received.body.invitations[0].canRespond, true);
  const [note] = await inbox(greenwood);
  assert.equal(note.type, 'match_invitation_received');
  assert.equal(note.category, 'matchInvitations');
  assert.equal(note.data.matchInvitationId, inv.id);
  assert.match(note.title, /Jeppe High Basketball v Greenwood Basketball/);
  assert.equal((await inbox(jeppe)).length, 0, 'the sender is not notified of their own invitation');

  // Accepting creates the fixture and tells the inviter.
  const accepted = await act(greenwood, inv.id, 'accept', { message: 'See you there' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.invitation.status, 'accepted');
  assert.equal(accepted.body.invitation.responseMessage, 'See you there');
  const fixtureId = accepted.body.invitation.fixtureId;
  assert.ok(fixtureId);

  const fixture = (await t.api('GET', `/api/fixtures/${fixtureId}`)).body.fixture;
  assert.equal(fixture.homeTeam.id, jeppe.team.id);
  assert.equal(fixture.awayTeam.id, greenwood.team.id);
  assert.equal(fixture.venue, 'Jeppe Court');
  assert.equal(fixture.status, 'scheduled');
  assert.equal(fixture.matchType, 'friendly');

  const [reply] = await inbox(jeppe);
  assert.equal(reply.type, 'match_invitation_accepted');
  assert.equal(reply.data.fixtureId, fixtureId);

  // It is closed now.
  const again = await act(greenwood, inv.id, 'accept');
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'INVITATION_CLOSED');
  assert.equal((await act(jeppe, inv.id, 'cancel')).status, 409);
});

test('playAt away makes the invited team the host', async () => {
  const res = await invite(kingEd, { opponentTeamId: jeppe.team.id, matchDate: inDays(10), playAt: 'away' });
  assert.equal(res.status, 201);
  assert.equal(res.body.invitation.homeTeam.id, jeppe.team.id);
  assert.equal(res.body.invitation.awayTeam.id, kingEd.team.id);
  assert.equal(res.body.invitation.invitedTeam.id, jeppe.team.id);

  const accepted = await act(jeppe, res.body.invitation.id, 'accept');
  const fixture = (await t.api('GET', `/api/fixtures/${accepted.body.invitation.fixtureId}`)).body.fixture;
  assert.equal(fixture.homeTeam.id, jeppe.team.id);
});

test('declining and withdrawing', async () => {
  const one = (await invite(kingEd, { opponentTeamId: greenwood.team.id, matchDate: inDays(3) })).body.invitation;
  const declined = await act(greenwood, one.id, 'decline', { message: 'Exams that week' });
  assert.equal(declined.status, 200);
  assert.equal(declined.body.invitation.status, 'declined');
  assert.equal(declined.body.invitation.fixtureId, null);
  const note = (await inbox(kingEd)).find((n) => n.type === 'match_invitation_declined');
  assert.match(note.body, /Exams that week/);

  const two = (await invite(kingEd, { opponentTeamId: greenwood.team.id, matchDate: inDays(4) })).body.invitation;
  const cancelled = await act(kingEd, two.id, 'cancel');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.invitation.status, 'cancelled');
  assert.ok((await inbox(greenwood)).some((n) => n.type === 'match_invitation_cancelled' && n.data.matchInvitationId === two.id));
});

test('only the right side can answer or withdraw; outsiders cannot see it', async () => {
  const inv = (await invite(jeppe, { opponentTeamId: greenwood.team.id, matchDate: inDays(20) })).body.invitation;

  const selfAccept = await act(jeppe, inv.id, 'accept');
  assert.equal(selfAccept.status, 403);
  assert.equal((await act(jeppe, inv.id, 'decline')).status, 403);
  assert.equal((await act(greenwood, inv.id, 'cancel')).status, 403);

  // A coach with nothing to do with it gets a 404, as if it did not exist.
  assert.equal((await t.api('GET', `/api/match-invitations/${inv.id}`, undefined, kingEd.token)).status, 404);
  assert.equal((await act(kingEd, inv.id, 'accept')).status, 404);
  const theirs = await t.api('GET', '/api/match-invitations', undefined, kingEd.token);
  assert.ok(!theirs.body.invitations.some((x) => x.id === inv.id));

  // Learners and anonymous users cannot use this at all.
  assert.equal((await t.api('GET', '/api/match-invitations', undefined, learner.token)).status, 403);
  assert.equal((await t.api('GET', '/api/match-invitations')).status, 401);

  // An admin can see and answer anything.
  assert.equal((await t.api('GET', `/api/match-invitations/${inv.id}`, undefined, admin.token)).status, 200);
  assert.equal((await act(admin, inv.id, 'decline')).status, 200);
});

test('validation and checks when sending', async () => {
  const send = (body) => invite(jeppe, { opponentTeamId: greenwood.team.id, matchDate: inDays(5), ...body });

  assert.equal((await send({ opponentTeamId: undefined })).status, 400);
  assert.equal((await send({ matchDate: '2030-01-01T10:00:00' })).status, 400, 'needs a time zone');
  assert.equal((await send({ matchDate: inDays(-1) })).body.error.code, 'MATCH_IN_PAST');
  assert.equal((await send({ playAt: 'moon' })).status, 400);
  assert.equal((await send({ matchType: 'exhibition' })).status, 400);
  assert.equal((await send({ message: 'x'.repeat(501) })).status, 400);
  assert.equal((await send({ opponentTeamId: jeppe.team.id })).body.error.code, 'SAME_TEAM');
  assert.equal((await send({ opponentTeamId: 99999 })).status, 404);
  assert.equal((await send({ opponentTeamId: football.team.id })).body.error.code, 'SPORT_MISMATCH');
  assert.equal((await send({ opponentTeamId: noCoachTeamId })).body.error.code, 'OPPONENT_HAS_NO_COACH');
  assert.equal((await send({ competitionId: 99999 })).body.error.code, 'UNKNOWN_COMPETITION');
  assert.equal((await send({ teamId: greenwood.team.id, opponentTeamId: kingEd.team.id })).status, 403, 'not your team');
  assert.equal((await invite(admin, { opponentTeamId: greenwood.team.id, matchDate: inDays(5) })).body.error.code, 'TEAM_REQUIRED');

  // The same two teams cannot have two open invitations for the same time, whoever sends them.
  const date = inDays(30);
  assert.equal((await send({ matchDate: date })).status, 201);
  const dup = await invite(greenwood, { opponentTeamId: jeppe.team.id, matchDate: date });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'INVITATION_EXISTS');
});

test('an invitation whose match time has passed shows as expired and cannot be accepted', async () => {
  const inv = (await invite(kingEd, { opponentTeamId: jeppe.team.id, matchDate: inDays(40) })).body.invitation;
  await t.pool.query("UPDATE match_invitations SET match_date = NOW() - INTERVAL '1 hour' WHERE id = $1", [inv.id]);

  const got = await t.api('GET', `/api/match-invitations/${inv.id}`, undefined, jeppe.token);
  assert.equal(got.body.invitation.status, 'expired');
  assert.equal(got.body.invitation.canRespond, false);
  const res = await act(jeppe, inv.id, 'accept');
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'INVITATION_CLOSED');

  const expired = await t.api('GET', '/api/match-invitations?status=expired', undefined, jeppe.token);
  assert.deepEqual(expired.body.invitations.map((x) => x.id), [inv.id]);
  const pending = await t.api('GET', '/api/match-invitations?status=pending', undefined, jeppe.token);
  assert.ok(!pending.body.invitations.some((x) => x.id === inv.id));
});

test('list filters: direction, status, teamId and paging', async () => {
  const sent = await t.api('GET', '/api/match-invitations?direction=sent', undefined, jeppe.token);
  assert.ok(sent.body.invitations.length > 0);
  assert.ok(sent.body.invitations.every((x) => x.inviterTeam.id === jeppe.team.id && x.direction === 'sent'));

  const received = await t.api('GET', '/api/match-invitations?direction=received', undefined, jeppe.token);
  assert.ok(received.body.invitations.every((x) => x.invitedTeam.id === jeppe.team.id && x.direction === 'received'));

  const all = await t.api('GET', '/api/match-invitations', undefined, jeppe.token);
  assert.equal(all.body.total, sent.body.total + received.body.total);

  const page = await t.api('GET', '/api/match-invitations?limit=1&offset=1', undefined, jeppe.token);
  assert.equal(page.body.invitations.length, 1);
  assert.equal(page.body.total, all.body.total);

  assert.equal((await t.api('GET', `/api/match-invitations?teamId=${greenwood.team.id}`, undefined, jeppe.token)).status, 403);
  const forAdmin = await t.api('GET', `/api/match-invitations?teamId=${jeppe.team.id}`, undefined, admin.token);
  assert.equal(forAdmin.body.total, all.body.total);
  assert.equal((await t.api('GET', '/api/match-invitations?status=open', undefined, jeppe.token)).status, 400);
});

test('a coach can switch match invitation notifications off', async () => {
  const off = await t.api('PUT', '/api/me/notifications/settings', { matchInvitations: false }, football.token);
  assert.equal(off.body.settings.matchInvitations, false);
  const other = await signUpCoach(t, { email: 'parktown2@example.com', school: 'Rosebank', team: { name: 'Rosebank Football', level: 'u16', sport: 'Football' } });
  other.team = await teamOf(other);
  assert.equal((await invite(other, { opponentTeamId: football.team.id, matchDate: inDays(6) })).status, 201);
  assert.equal((await inbox(football)).length, 0);
});
