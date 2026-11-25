// Live scoring: coaches add goals, the other coach confirms or disputes, full time writes the result.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, makeAdmin, learnerPayload } = require('./helpers/setup');

let t;
let home, away, outsider, learner, admin;

const minutesFromNow = (m) => new Date(Date.now() + m * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const teamOf = async (coach) => (await t.api('GET', '/api/teams?mine=true', undefined, coach.token)).body.teams[0];
const post = (who, url, body = {}) => t.api('POST', url, body, who.token);
const inbox = async (who) => (await t.api('GET', '/api/me/notifications', undefined, who.token)).body.notifications;

// A fixture between home and away, kicking off `startsIn` minutes from now.
async function fixture(startsIn = 0) {
  const res = await post(home, '/api/fixtures', { homeTeamId: home.team.id, awayTeamId: away.team.id, matchDate: minutesFromNow(startsIn) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.fixture.id;
}
async function liveFixture() {
  const id = await fixture();
  assert.equal((await post(home, `/api/fixtures/${id}/start`)).status, 200);
  return id;
}

before(async () => {
  t = await startTestApp();
  home = await signUpCoach(t, { email: 'home@example.com', school: 'Jeppe High', team: { name: 'Jeppe Football', level: '1st_team', sport: 'Football' } });
  away = await signUpCoach(t, { email: 'away@example.com', school: 'Greenwood', team: { name: 'Greenwood Football', level: '1st_team', sport: 'Football' } });
  outsider = await signUpCoach(t, { email: 'out@example.com', school: 'Parktown', team: { name: 'Parktown Football', level: '1st_team', sport: 'Football' } });
  for (const c of [home, away, outsider]) c.team = await teamOf(c);
  learner = await signUpLearner(t, learnerPayload({ email: 'striker@example.com', firstName: 'Thabo', lastName: 'Mokoena' }));
  admin = await signUpLearner(t, learnerPayload({ email: 'admin@example.com' }));
  await makeAdmin(t, 'admin@example.com');
  assert.equal((await post(home, `/api/teams/${home.team.id}/roster`, { userId: learner.user.id })).status, 201);
});
after(async () => { await t.stop(); });

test('a goal waits for the other coach, then counts once confirmed', async () => {
  const id = await liveFixture();

  const added = await post(home, `/api/fixtures/${id}/goals`, { minute: 23, playerId: learner.user.id });
  assert.equal(added.status, 201);
  const goal = added.body.goal;
  assert.equal(goal.status, 'pending');
  assert.equal(goal.side, 'home');
  assert.equal(goal.team.id, home.team.id);
  assert.equal(goal.minute, 23);
  assert.equal(goal.points, 1);
  assert.equal(goal.player.name, 'Thabo Mokoena');
  assert.equal(goal.canConfirm, false, 'you cannot confirm your own goal');
  assert.equal(goal.canDelete, true);
  assert.deepEqual(added.body.score, { home: 0, away: 0 }, 'not counted yet');
  assert.deepEqual(added.body.pending, { home: 1, away: 0 });

  // The fixture shows the live score from confirmed goals, and the pending count.
  let f = (await t.api('GET', `/api/fixtures/${id}`)).body.fixture;
  assert.equal(f.status, 'live');
  assert.ok(f.startedAt);
  assert.deepEqual(f.score, { home: 0, away: 0 });
  assert.deepEqual(f.pendingGoals, { home: 1, away: 0 });

  // The away coach is asked to confirm it.
  const [note] = await inbox(away);
  assert.equal(note.type, 'goal_confirmation_needed');
  assert.equal(note.category, 'goalConfirmations');
  assert.equal(note.data.goalId, goal.id);
  assert.equal(note.data.fixtureId, id);
  assert.match(note.title, /Jeppe Football \(23'\)/);
  assert.equal((await inbox(home)).length, 0);

  const asAway = (await t.api('GET', `/api/fixtures/${id}/goals`, undefined, away.token)).body.goals[0];
  assert.equal(asAway.canConfirm, true);
  assert.equal(asAway.canDispute, true);
  assert.equal(asAway.canDelete, false);

  assert.equal((await post(home, `/api/fixtures/${id}/goals/${goal.id}/confirm`)).status, 403, 'not by the side that added it');
  const confirmed = await post(away, `/api/fixtures/${id}/goals/${goal.id}/confirm`);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.goal.status, 'confirmed');
  assert.equal(confirmed.body.goal.autoConfirmed, false);
  assert.deepEqual(confirmed.body.score, { home: 1, away: 0 });
  assert.equal((await post(away, `/api/fixtures/${id}/goals/${goal.id}/confirm`)).body.error.code, 'ALREADY_CONFIRMED');

  f = (await t.api('GET', `/api/fixtures/${id}`)).body.fixture;
  assert.deepEqual(f.score, { home: 1, away: 0 });
  assert.deepEqual(f.pendingGoals, { home: 0, away: 0 });
});

test('a disputed goal does not count; the adder can remove it, or it can still be confirmed', async () => {
  const id = await liveFixture();
  const a = (await post(away, `/api/fixtures/${id}/goals`, { minute: 10 })).body.goal;
  assert.equal(a.side, 'away');

  const disputed = await post(home, `/api/fixtures/${id}/goals/${a.id}/dispute`, { reason: 'Offside' });
  assert.equal(disputed.status, 200);
  assert.equal(disputed.body.goal.status, 'disputed');
  assert.equal(disputed.body.goal.disputeReason, 'Offside');
  assert.deepEqual(disputed.body.score, { home: 0, away: 0 });
  assert.deepEqual(disputed.body.disputed, { home: 0, away: 1 });
  const note = (await inbox(away)).find((n) => n.type === 'goal_disputed');
  assert.match(note.body, /Offside/);
  assert.equal((await post(home, `/api/fixtures/${id}/goals/${a.id}/dispute`)).body.error.code, 'GOAL_NOT_PENDING');

  // Changing their mind: a disputed goal can still be confirmed.
  const ok = await post(home, `/api/fixtures/${id}/goals/${a.id}/confirm`);
  assert.equal(ok.body.goal.status, 'confirmed');
  assert.deepEqual(ok.body.score, { home: 0, away: 1 });

  // The coach who added a goal can take it back; the other coach cannot delete it.
  const b = (await post(away, `/api/fixtures/${id}/goals`, { minute: 50 })).body.goal;
  assert.equal((await t.api('DELETE', `/api/fixtures/${id}/goals/${b.id}`, undefined, home.token)).status, 403);
  const removed = await t.api('DELETE', `/api/fixtures/${id}/goals/${b.id}`, undefined, away.token);
  assert.equal(removed.status, 200);
  assert.ok(!removed.body.goals.some((g) => g.id === b.id));
  assert.equal((await t.api('DELETE', `/api/fixtures/${id}/goals/${b.id}`, undefined, away.token)).status, 404);
});

test('full time confirms unanswered goals, leaves out disputed ones and records the result', async () => {
  const id = await liveFixture();
  const g1 = (await post(home, `/api/fixtures/${id}/goals`, { minute: 5 })).body.goal;
  const g2 = (await post(home, `/api/fixtures/${id}/goals`, { minute: 60 })).body.goal;
  const g3 = (await post(away, `/api/fixtures/${id}/goals`, { minute: 70, points: 3 })).body.goal;
  await post(away, `/api/fixtures/${id}/goals/${g1.id}/confirm`);
  await post(home, `/api/fixtures/${id}/goals/${g3.id}/dispute`, { reason: 'Never crossed the line' });

  const finished = await post(away, `/api/fixtures/${id}/finish`);
  assert.equal(finished.status, 200);
  assert.equal(finished.body.fixture.status, 'finished');
  const byId = Object.fromEntries(finished.body.goals.map((g) => [g.id, g]));
  assert.equal(byId[g1.id].autoConfirmed, false);
  assert.equal(byId[g2.id].status, 'confirmed');
  assert.equal(byId[g2.id].autoConfirmed, true, 'nobody answered it, so full time confirmed it');
  assert.equal(byId[g3.id].status, 'disputed', 'disputed goals stay out');
  assert.deepEqual(finished.body.score, { home: 2, away: 0 });
  assert.deepEqual(finished.body.fixture.score, { home: 2, away: 0 });
  assert.equal(finished.body.fixture.winner, 'home');
  assert.equal(finished.body.fixture.pendingGoals, null);
  assert.ok(finished.body.goals.every((g) => !g.canConfirm && !g.canDispute && !g.canDelete), 'locked after full time');

  // The result is a normal result: it shows on the results list and is stored in scores.
  const { rows: [s] } = await t.pool.query('SELECT home_team_score, away_team_score FROM scores WHERE fixture_id = $1', [id]);
  assert.deepEqual(s, { home_team_score: 2, away_team_score: 0 });
  const results = await t.api('GET', '/api/fixtures?when=past');
  assert.ok(results.body.fixtures.some((f) => f.id === id));

  // Nothing can change after full time.
  assert.equal((await post(home, `/api/fixtures/${id}/goals`, {})).body.error.code, 'MATCH_NOT_LIVE');
  assert.equal((await post(home, `/api/fixtures/${id}/goals/${g3.id}/confirm`)).body.error.code, 'MATCH_NOT_LIVE');
  assert.equal((await post(home, `/api/fixtures/${id}/finish`)).body.error.code, 'MATCH_NOT_LIVE');
});

test('starting a match: who, when, and what is blocked while it is live', async () => {
  const later = await fixture(3 * 60);
  const tooEarly = await post(home, `/api/fixtures/${later}/start`);
  assert.equal(tooEarly.status, 409);
  assert.equal(tooEarly.body.error.code, 'TOO_EARLY');

  const soon = await fixture(30);
  assert.equal((await post(outsider, `/api/fixtures/${soon}/start`)).status, 403);
  assert.equal((await post(learner, `/api/fixtures/${soon}/start`)).status, 403);
  assert.equal((await post(home, `/api/fixtures/${soon}/goals`, {})).body.error.code, 'MATCH_NOT_STARTED');
  const started = await post(away, `/api/fixtures/${soon}/start`);
  assert.equal(started.status, 200, 'either coach can start it, up to an hour early');
  assert.equal(started.body.fixture.status, 'live');
  assert.equal((await post(home, `/api/fixtures/${soon}/start`)).body.error.code, 'MATCH_NOT_LIVE');

  // While live, the manual result entry and editing are blocked.
  const manual = await t.api('PUT', `/api/fixtures/${soon}/result`, { homeScore: 3, awayScore: 0 }, home.token);
  assert.equal(manual.status, 409);
  assert.equal(manual.body.error.code, 'MATCH_LIVE');
  assert.equal((await t.api('PATCH', `/api/fixtures/${soon}`, { venue: 'Elsewhere' }, home.token)).status, 409);
  assert.equal((await t.api('GET', '/api/fixtures/999999/goals')).status, 404);
});

test('adding goals: validation, outsiders, and admins', async () => {
  const id = await liveFixture();
  const add = (who, body) => post(who, `/api/fixtures/${id}/goals`, body);

  assert.equal((await add(outsider, {})).status, 403);
  assert.equal((await add(learner, {})).status, 403);
  assert.equal((await t.api('POST', `/api/fixtures/${id}/goals`, {})).status, 401);
  assert.equal((await add(home, { minute: 201 })).status, 400);
  assert.equal((await add(home, { points: 0 })).status, 400);
  assert.equal((await add(home, { points: 11 })).status, 400);
  assert.equal((await add(home, { teamId: outsider.team.id })).body.error.code, 'TEAM_NOT_PLAYING');
  assert.equal((await add(away, { playerId: learner.user.id })).body.error.code, 'NOT_ON_TEAM', 'the player is in the home squad');
  assert.equal((await add(admin, {})).body.error.code, 'TEAM_REQUIRED');

  // A coach may also record a goal for the other side (an own goal, say); the other coach still confirms it.
  const ownGoal = (await add(home, { teamId: away.team.id, minute: 88 })).body.goal;
  assert.equal(ownGoal.side, 'away');
  assert.equal(ownGoal.status, 'pending');
  assert.equal(ownGoal.addedByTeamId, home.team.id);

  // Goals an admin adds count straight away; an admin can also confirm anyone's goal.
  const byAdmin = await add(admin, { teamId: home.team.id });
  assert.equal(byAdmin.body.goal.status, 'confirmed');
  assert.equal((await post(admin, `/api/fixtures/${id}/goals/${ownGoal.id}/confirm`)).body.goal.status, 'confirmed');

  // Anyone can follow the live score, without logging in.
  const pub = await t.api('GET', `/api/fixtures/${id}/goals`);
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.body.score, { home: 1, away: 1 });
  assert.ok(pub.body.goals.every((g) => !g.canConfirm && !g.canDelete));
  assert.equal((await post(home, `/api/fixtures/${id}/goals/999999/confirm`)).status, 404);
});

test('a coach can switch goal confirmation notifications off', async () => {
  await t.api('PUT', '/api/me/notifications/settings', { goalConfirmations: false }, outsider.token);
  const res = await post(outsider, '/api/fixtures', { homeTeamId: outsider.team.id, awayTeamId: home.team.id, matchDate: minutesFromNow(0) });
  const id = res.body.fixture.id;
  await post(outsider, `/api/fixtures/${id}/start`);
  const before = (await inbox(outsider)).length;
  await post(home, `/api/fixtures/${id}/goals`, {});
  assert.equal((await inbox(outsider)).length, before);
});
