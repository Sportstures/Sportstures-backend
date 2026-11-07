const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, makeAdmin, learnerPayload } = require('./helpers/setup');

let t;
let coachA, coachB, coachC, admin;
let p1, p2, p3, p4, outsider, pending; // learners
let teamA, teamB, teamC;
let fixture, otherFixture;

const learner = (email, firstName, school) => signUpLearner(t, learnerPayload({
  email, firstName, lastName: 'Player', school: { name: school, grade: 9, className: '9A' }, sport: null,
}));
const mineTeam = async (coach) => (await t.api('GET', '/api/teams?mine=true', undefined, coach.token)).body.teams[0];
const addToTeam = (coach, team, player, jerseyNumber, position) =>
  t.api('POST', `/api/teams/${team.id}/roster`, { userId: player.user.id, jerseyNumber, position }, coach.token);
const put = (fx, team, body, token) => t.api('PUT', `/api/fixtures/${fx.id}/lineups/${team.id}`, body, token);
const get = (fx, token) => t.api('GET', `/api/fixtures/${fx.id}/lineups`, undefined, token);
const setStatus = (id, status) => t.pool.query('UPDATE fixtures SET status = $1 WHERE id = $2', [status, id]);

before(async () => {
  t = await startTestApp();
  const basketball = (name, school) => ({ school, team: { name, level: '1st_team', sport: 'Basketball' } });
  coachA = await signUpCoach(t, { email: 'a@example.com', ...basketball('Alpha Boys', 'Alpha High') });
  coachB = await signUpCoach(t, { email: 'b@example.com', ...basketball('Bravo Boys', 'Bravo High') });
  coachC = await signUpCoach(t, { email: 'c@example.com', ...basketball('Charlie Boys', 'Charlie High') });
  p1 = await learner('p1@example.com', 'Pat', 'Alpha High');
  p2 = await learner('p2@example.com', 'Quinn', 'Alpha High');
  p3 = await learner('p3@example.com', 'Rae', 'Alpha High');
  p4 = await learner('p4@example.com', 'Sam', 'Bravo High');
  outsider = await learner('out@example.com', 'Tia', 'Alpha High');
  pending = await learner('pend@example.com', 'Uma', 'Alpha High');
  admin = await learner('admin@example.com', 'Ad', 'Alpha High');
  await makeAdmin(t, 'admin@example.com');
  [teamA, teamB, teamC] = await Promise.all([coachA, coachB, coachC].map(mineTeam));

  await addToTeam(coachA, teamA, p1, 4, 'Guard');
  await addToTeam(coachA, teamA, p2, 9, 'Forward');
  await addToTeam(coachA, teamA, p3, 12);
  await addToTeam(coachB, teamB, p4, 5, 'Centre');
  await t.api('POST', `/api/teams/${teamA.id}/join-requests`, {}, pending.token);

  const sched = async (token, home, away, matchDate) =>
    (await t.api('POST', '/api/fixtures', { homeTeamId: home.id, awayTeamId: away.id, matchDate }, token)).body.fixture;
  fixture = await sched(coachA.token, teamA, teamB, '2099-03-01T15:00:00Z'); // A (home) v B
  otherFixture = await sched(coachC.token, teamC, teamB, '2099-03-08T15:00:00Z'); // C v B
});
after(async () => { await t.stop(); });

test('a new fixture shows no lineups submitted', async () => {
  const res = await t.api('GET', `/api/fixtures/${fixture.id}`, undefined, coachA.token);
  assert.deepEqual(res.body.fixture.lineupSubmitted, { home: false, away: false });
  const lineups = await get(fixture, coachA.token);
  assert.equal(lineups.status, 200);
  assert.equal(lineups.body.home.submitted, false);
  assert.equal(lineups.body.home.lineup, null);
});

test('the home coach submits a lineup; jersey and position come from the roster', async () => {
  const res = await put(fixture, teamA, {
    formation: '4-4-2',
    starters: [{ userId: p1.user.id }, { userId: p2.user.id, position: 'Wing' }],
    bench: [{ userId: p3.user.id }],
  }, coachA.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const l = res.body.lineup;
  assert.equal(l.formation, '4-4-2');
  assert.deepEqual(l.starters.map((p) => [p.name, p.jerseyNumber, p.position]),
    [['Pat Player', 4, 'Guard'], ['Quinn Player', 9, 'Wing']], 'a position given in the lineup overrides the roster one');
  assert.deepEqual(l.bench.map((p) => [p.name, p.jerseyNumber, p.position]), [['Rae Player', 12, null]]);

  const fx = await t.api('GET', `/api/fixtures/${fixture.id}`, undefined, coachB.token);
  assert.deepEqual(fx.body.fixture.lineupSubmitted, { home: true, away: false });
});

test('submitting again replaces the lineup instead of adding to it', async () => {
  const res = await put(fixture, teamA, { starters: [{ userId: p3.user.id }] }, coachA.token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.lineup.starters.map((p) => p.name), ['Rae Player']);
  assert.deepEqual(res.body.lineup.bench, []);
  assert.equal(res.body.lineup.formation, null);
  const count = await t.pool.query('SELECT count(*)::int AS n FROM fixture_lineups WHERE fixture_id = $1', [fixture.id]);
  assert.equal(count.rows[0].n, 1);
});

test('only the team\'s own coach (or an admin) can submit', async () => {
  const body = { starters: [{ userId: p4.user.id }] };
  assert.equal((await put(fixture, teamB, body, coachA.token)).status, 403, 'the other team\'s coach');
  assert.equal((await put(fixture, teamA, { starters: [{ userId: p1.user.id }] }, coachB.token)).status, 403);
  assert.equal((await put(fixture, teamA, { starters: [{ userId: p1.user.id }] }, coachC.token)).status, 403, 'a coach not in the fixture');
  assert.equal((await put(fixture, teamA, { starters: [{ userId: p1.user.id }] }, p1.token)).status, 403, 'a learner');
  assert.equal((await put(fixture, teamA, { starters: [{ userId: p1.user.id }] })).status, 401);
  assert.equal((await put(fixture, teamB, body, admin.token)).status, 200, 'an admin can');
});

test('validation: players must be active members, no duplicates, starters required', async () => {
  const notOnTeam = await put(fixture, teamA, { starters: [{ userId: p1.user.id }, { userId: outsider.user.id }] }, coachA.token);
  assert.equal(notOnTeam.status, 422);
  assert.equal(notOnTeam.body.error.code, 'NOT_ON_TEAM');
  assert.deepEqual(notOnTeam.body.error.details.userIds, [outsider.user.id]);

  assert.equal((await put(fixture, teamA, { starters: [{ userId: pending.user.id }] }, coachA.token)).body.error.code, 'NOT_ON_TEAM', 'pending is not enough');
  assert.equal((await put(fixture, teamA, { starters: [{ userId: p4.user.id }] }, coachA.token)).body.error.code, 'NOT_ON_TEAM', 'another team\'s player');

  const dup = await put(fixture, teamA, { starters: [{ userId: p1.user.id }], bench: [{ userId: p1.user.id }] }, coachA.token);
  assert.equal(dup.status, 422);
  assert.equal(dup.body.error.code, 'DUPLICATE_PLAYER');

  assert.equal((await put(fixture, teamA, { starters: [] }, coachA.token)).status, 400);
  assert.equal((await put(fixture, teamA, {}, coachA.token)).status, 400);
  assert.equal((await put(fixture, teamA, { starters: [{ userId: 'x' }] }, coachA.token)).status, 400);

  const kept = await get(fixture, coachA.token);
  assert.deepEqual(kept.body.home.lineup.starters.map((p) => p.name), ['Rae Player'], 'a failed submit changes nothing');
});

test('a team that is not in the fixture is rejected', async () => {
  const res = await put(fixture, teamC, { starters: [{ userId: p1.user.id }] }, coachA.token);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'TEAM_NOT_IN_FIXTURE');
  assert.equal((await put({ id: 99999 }, teamA, { starters: [{ userId: p1.user.id }] }, coachA.token)).status, 404);
});

test('privacy: before the match only the team\'s coach, admins and its players see the lineup', async () => {
  const seen = async (token) => (await get(fixture, token)).body.home;
  assert.ok((await seen(coachA.token)).lineup, 'own coach');
  assert.ok((await seen(admin.token)).lineup, 'admin');
  assert.ok((await seen(p1.token)).lineup, 'an active player on the team');

  for (const [who, token] of [['opposing coach', coachB.token], ['unrelated learner', outsider.token], ['pending player', pending.token]]) {
    const side = await seen(token);
    assert.equal(side.lineup, null, who);
    assert.equal(side.submitted, true, `${who} can still see that one was submitted`);
  }
});

test('once the match is live the lineups are public', async () => {
  await setStatus(fixture.id, 'live');
  const res = await get(fixture, outsider.token);
  assert.equal(res.body.public, true);
  assert.equal(res.body.home.lineup.starters.length, 1);
  assert.equal(res.body.away.lineup.starters[0].name, 'Sam Player');
});

test('a lineup can still be changed while live, but not once finished or cancelled', async () => {
  assert.equal((await put(fixture, teamA, { starters: [{ userId: p1.user.id }] }, coachA.token)).status, 200);
  await setStatus(fixture.id, 'finished');
  const closed = await put(fixture, teamA, { starters: [{ userId: p2.user.id }] }, coachA.token);
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error.code, 'FIXTURE_CLOSED');
  assert.equal((await t.api('DELETE', `/api/fixtures/${fixture.id}/lineups/${teamA.id}`, undefined, coachA.token)).status, 409);
  assert.ok((await get(fixture, outsider.token)).body.home.lineup, 'finished lineups stay public');
  await setStatus(fixture.id, 'cancelled');
  assert.equal((await put(fixture, teamB, { starters: [{ userId: p4.user.id }] }, coachB.token)).status, 409);
  await setStatus(fixture.id, 'scheduled');
});

test('the roster changing later does not rewrite a submitted lineup', async () => {
  await t.api('PATCH', `/api/teams/${teamA.id}/roster/${p1.user.id}`, { jerseyNumber: 99 }, coachA.token);
  const l = (await get(fixture, coachA.token)).body.home.lineup;
  assert.equal(l.starters[0].name, 'Pat Player');
  assert.equal(l.starters[0].jerseyNumber, 4, 'the number at submission time');
});

test('a coach can withdraw a lineup', async () => {
  const del = await t.api('DELETE', `/api/fixtures/${fixture.id}/lineups/${teamA.id}`, undefined, coachA.token);
  assert.equal(del.status, 204);
  assert.equal((await get(fixture, coachA.token)).body.home.submitted, false);
  assert.equal((await t.api('DELETE', `/api/fixtures/${fixture.id}/lineups/${teamA.id}`, undefined, coachA.token)).status, 404);
  assert.equal((await t.api('DELETE', `/api/fixtures/${fixture.id}/lineups/${teamB.id}`, undefined, coachA.token)).status, 403);
});

test('removing a player from the roster does not break reading a lineup; deleting the fixture clears it', async () => {
  await put(fixture, teamA, { starters: [{ userId: p2.user.id }] }, coachA.token);
  await t.api('DELETE', `/api/teams/${teamA.id}/roster/${p2.user.id}`, undefined, coachA.token);
  const l = (await get(fixture, coachA.token)).body.home.lineup;
  assert.equal(l.starters[0].name, 'Quinn Player', 'the submitted sheet is a record');

  await t.pool.query('DELETE FROM fixtures WHERE id = $1', [fixture.id]);
  const left = await t.pool.query('SELECT (SELECT count(*) FROM fixture_lineups)::int AS l, (SELECT count(*) FROM fixture_lineup_players)::int AS p');
  assert.deepEqual(left.rows[0], { l: 0, p: 0 });
  assert.equal(otherFixture.homeTeam.id, teamC.id);
});
