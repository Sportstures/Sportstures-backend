const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, makeAdmin, learnerPayload } = require('./helpers/setup');

let t;
let coachA, coachB, admin;
let lena, mia, noah, omar; // learners
let teamA, teamB;

const learner = (email, firstName, lastName, school, className = '9A') => signUpLearner(t, learnerPayload({
  email, firstName, lastName, school: { name: school, grade: 9, className }, sport: null,
}));
const mineTeam = async (coach) => (await t.api('GET', '/api/teams?mine=true', undefined, coach.token)).body.teams[0];
const roster = (team, token, status) => t.api('GET', `/api/teams/${team.id}/roster${status ? `?status=${status}` : ''}`, undefined, token);
const names = (res) => res.body.roster.map((m) => m.name);

before(async () => {
  t = await startTestApp();
  const basketball = (name, school) => ({ school, team: { name, level: '1st_team', sport: 'Basketball' } });
  coachA = await signUpCoach(t, { email: 'a@example.com', ...basketball('Alpha Boys', 'Alpha High') });
  coachB = await signUpCoach(t, { email: 'b@example.com', ...basketball('Bravo Boys', 'Bravo High') });
  lena = await learner('lena@example.com', 'Lena', 'One', 'Alpha High');
  mia = await learner('mia@example.com', 'Mia', 'Two', 'Alpha High', '9B');
  noah = await learner('noah@example.com', 'Noah', 'Three', 'Alpha High');
  omar = await learner('omar@example.com', 'Omar', 'Four', 'Bravo High');
  admin = await learner('admin@example.com', 'Ad', 'Min', 'Alpha High');
  await makeAdmin(t, 'admin@example.com');
  teamA = await mineTeam(coachA);
  teamB = await mineTeam(coachB);

  // A learner who signed up but never verified their email.
  await t.api('POST', '/api/auth/register', learnerPayload({ email: 'ghost@example.com', firstName: 'Ghost', lastName: 'Unverified', school: { name: 'Alpha High', grade: 9, className: '9A' }, sport: null }));
});
after(async () => { await t.stop(); });

// ------------------------------------------------------------------ joining

test('a learner can ask to join a team; the request is pending', async () => {
  const res = await t.api('POST', `/api/teams/${teamA.id}/join-requests`, { jerseyNumber: 7 }, lena.token);
  assert.equal(res.status, 201);
  assert.equal(res.body.member.status, 'pending');
  assert.equal(res.body.member.jerseyNumber, 7);
  assert.equal(res.body.member.name, 'Lena One');
});

test('join request rules: no duplicates, learners only, real team, logged in', async () => {
  const again = await t.api('POST', `/api/teams/${teamA.id}/join-requests`, {}, lena.token);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'REQUEST_PENDING');

  assert.equal((await t.api('POST', `/api/teams/${teamA.id}/join-requests`, {}, coachB.token)).status, 403, 'coaches cannot join teams');
  assert.equal((await t.api('POST', '/api/teams/99999/join-requests', {}, mia.token)).status, 404);
  assert.equal((await t.api('POST', `/api/teams/${teamA.id}/join-requests`, {})).status, 401);
  assert.equal((await t.api('POST', `/api/teams/${teamA.id}/join-requests`, { jerseyNumber: 5000 }, mia.token)).status, 400);
});

test('/api/me/teams shows my pending request with the team', async () => {
  const res = await t.api('GET', '/api/me/teams', undefined, lena.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.teams.length, 1);
  assert.equal(res.body.teams[0].status, 'pending');
  assert.equal(res.body.teams[0].team.name, 'Alpha Boys');
  assert.equal(res.body.teams[0].team.sport.name, 'Basketball');
  assert.deepEqual((await t.api('GET', '/api/me/teams', undefined, mia.token)).body.teams, []);
});

// ------------------------------------------------------------------ privacy

test('privacy: only the team\'s coach, admins and active players see the roster', async () => {
  assert.equal((await roster(teamA, coachA.token)).status, 200);
  assert.equal((await roster(teamA, admin.token)).status, 200);
  assert.equal((await roster(teamA, coachB.token)).status, 403, 'another team\'s coach');
  assert.equal((await roster(teamA, mia.token)).status, 403, 'a learner who is not on the team');
  assert.equal((await roster(teamA, lena.token)).status, 403, 'a learner whose request is still pending');
  assert.equal((await t.api('GET', `/api/teams/${teamA.id}/roster`)).status, 401);
  assert.equal((await t.api('GET', '/api/teams/99999/roster', undefined, coachA.token)).status, 404);
});

test('join requests are listed for the coach only', async () => {
  const pending = await roster(teamA, coachA.token, 'pending');
  assert.equal(pending.status, 200);
  assert.deepEqual(names(pending), ['Lena One']);
  assert.ok(pending.body.roster[0].requestedAt);
  assert.deepEqual(names(await roster(teamA, coachA.token)), [], 'not on the active roster yet');
  assert.equal((await roster(teamA, lena.token, 'pending')).status, 403);
});

// ------------------------------------------------------------------ approving and adding

test('the coach approves a request: the player becomes active with a number', async () => {
  const res = await t.api('PATCH', `/api/teams/${teamA.id}/roster/${lena.user.id}`, { status: 'active', jerseyNumber: 7, position: 'Guard' }, coachA.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.member.status, 'active');
  assert.equal(res.body.member.jerseyNumber, 7);
  assert.equal(res.body.member.position, 'Guard');
  assert.ok(res.body.member.joinedAt);
  assert.equal(res.body.member.grade, 9);
  assert.equal(res.body.member.className, '9A');
});

test('an active player can now see the roster, and the team shows a player count', async () => {
  const res = await roster(teamA, lena.token);
  assert.equal(res.status, 200);
  assert.deepEqual(names(res), ['Lena One']);
  assert.equal((await t.api('GET', `/api/teams/${teamA.id}`, undefined, mia.token)).body.team.playerCount, 1, 'anyone sees the count');
  assert.equal((await t.api('GET', `/api/teams/${teamB.id}`, undefined, mia.token)).body.team.playerCount, 0);
  const mine = await t.api('GET', '/api/me/teams', undefined, lena.token);
  assert.equal(mine.body.teams[0].status, 'active');
  assert.equal(mine.body.teams[0].jerseyNumber, 7);
});

test('two active players cannot share a jersey number', async () => {
  await t.api('POST', `/api/teams/${teamA.id}/join-requests`, { jerseyNumber: 7 }, mia.token);
  assert.equal((await roster(teamA, coachA.token, 'pending')).body.roster.length, 1, 'a pending request may ask for a taken number');

  const clash = await t.api('PATCH', `/api/teams/${teamA.id}/roster/${mia.user.id}`, { status: 'active' }, coachA.token);
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, 'JERSEY_TAKEN');

  const ok = await t.api('PATCH', `/api/teams/${teamA.id}/roster/${mia.user.id}`, { status: 'active', jerseyNumber: 10, position: 'Forward' }, coachA.token);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.member.jerseyNumber, 10);
});

test('candidates: learners from the team\'s school, not already on it, and verified', async () => {
  const res = await t.api('GET', `/api/teams/${teamA.id}/candidates`, undefined, coachA.token);
  assert.equal(res.status, 200);
  const found = res.body.candidates.map((c) => c.name).sort();
  assert.deepEqual(found, ['Noah Three'], 'not Lena or Mia (on the team), Omar (other school), Ghost (unverified) or the admin (not a learner)');
  assert.equal(res.body.candidates[0].grade, 9);

  const search = await t.api('GET', `/api/teams/${teamA.id}/candidates?q=noah`, undefined, coachA.token);
  assert.deepEqual(search.body.candidates.map((c) => c.name), ['Noah Three']);

  assert.equal((await t.api('GET', `/api/teams/${teamA.id}/candidates`, undefined, coachB.token)).status, 403);
  assert.equal((await t.api('GET', `/api/teams/${teamA.id}/candidates`, undefined, noah.token)).status, 403);
});

test('the coach can add a learner straight onto the team', async () => {
  const res = await t.api('POST', `/api/teams/${teamA.id}/roster`, { userId: noah.user.id, jerseyNumber: 3, position: 'Centre' }, coachA.token);
  assert.equal(res.status, 201);
  assert.equal(res.body.member.status, 'active');
  assert.equal(res.body.member.name, 'Noah Three');
});

test('adding a player: duplicates, wrong school, non-learners, unknown users, taken numbers', async () => {
  const dupe = await t.api('POST', `/api/teams/${teamA.id}/roster`, { userId: noah.user.id }, coachA.token);
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.error.code, 'ALREADY_MEMBER');

  const school = await t.api('POST', `/api/teams/${teamA.id}/roster`, { userId: omar.user.id }, coachA.token);
  assert.equal(school.status, 409);
  assert.equal(school.body.error.code, 'SCHOOL_MISMATCH');

  const notLearner = await t.api('POST', `/api/teams/${teamA.id}/roster`, { userId: coachB.user.id }, coachA.token);
  assert.equal(notLearner.status, 400);
  assert.equal(notLearner.body.error.code, 'NOT_A_LEARNER');

  assert.equal((await t.api('POST', `/api/teams/${teamA.id}/roster`, { userId: 99999 }, coachA.token)).status, 404);
  assert.equal((await t.api('POST', `/api/teams/${teamA.id}/roster`, {}, coachA.token)).status, 400);

  const adminAdd = await t.api('POST', `/api/teams/${teamA.id}/roster`, { userId: omar.user.id, jerseyNumber: 3 }, admin.token);
  assert.equal(adminAdd.status, 409, 'number 3 is taken by Noah');
  assert.equal(adminAdd.body.error.code, 'JERSEY_TAKEN');
  const adminOk = await t.api('POST', `/api/teams/${teamA.id}/roster`, { userId: omar.user.id, jerseyNumber: 99 }, admin.token);
  assert.equal(adminOk.status, 201, 'admins may add a learner from another school');
  await t.api('DELETE', `/api/teams/${teamA.id}/roster/${omar.user.id}`, undefined, admin.token);

  const adminAsMember = await t.api('POST', `/api/teams/${teamA.id}/roster`, { userId: admin.user.id }, admin.token);
  assert.equal(adminAsMember.status, 400, 'an admin account is not a learner');
});

test('adding a learner who has a pending request approves it (200, not a duplicate)', async () => {
  await t.api('POST', `/api/teams/${teamB.id}/join-requests`, {}, omar.token);
  const res = await t.api('POST', `/api/teams/${teamB.id}/roster`, { userId: omar.user.id, jerseyNumber: 4 }, coachB.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.member.status, 'active');
  const count = await t.pool.query('SELECT count(*)::int n FROM team_members WHERE team_id = $1 AND user_id = $2', [teamB.id, omar.user.id]);
  assert.equal(count.rows[0].n, 1);
});

// ------------------------------------------------------------------ the roster list

test('the roster is ordered by jersey number', async () => {
  const res = await roster(teamA, coachA.token);
  assert.deepEqual(res.body.roster.map((m) => [m.jerseyNumber, m.name]), [[3, 'Noah Three'], [7, 'Lena One'], [10, 'Mia Two']]);
  assert.equal(res.body.count, 3);
  assert.equal(res.body.team.name, 'Alpha Boys');
});

// ------------------------------------------------------------------ editing and removing

test('only the team\'s coach (or an admin) can change the roster', async () => {
  const path = `/api/teams/${teamA.id}/roster/${mia.user.id}`;
  assert.equal((await t.api('PATCH', path, { position: 'x' }, coachB.token)).status, 403);
  assert.equal((await t.api('DELETE', path, undefined, coachB.token)).status, 403);
  assert.equal((await t.api('POST', `/api/teams/${teamA.id}/roster`, { userId: omar.user.id }, coachB.token)).status, 403);
  assert.equal((await t.api('PATCH', path, { position: 'x' }, mia.token)).status, 403, 'players cannot edit themselves');
  assert.equal((await t.api('DELETE', path, undefined, mia.token)).status, 403);
  assert.equal((await t.api('PATCH', path, { position: 'x' })).status, 401);
});

test('edit a number or position, clear a number, validate input', async () => {
  const path = `/api/teams/${teamA.id}/roster/${mia.user.id}`;
  const edited = await t.api('PATCH', path, { position: 'Point guard', jerseyNumber: 11 }, coachA.token);
  assert.equal(edited.body.member.position, 'Point guard');
  assert.equal(edited.body.member.jerseyNumber, 11);

  const cleared = await t.api('PATCH', path, { jerseyNumber: null }, coachA.token);
  assert.equal(cleared.body.member.jerseyNumber, null);
  assert.equal(cleared.body.member.position, 'Point guard', 'fields not sent stay as they were');

  assert.equal((await t.api('PATCH', path, { jerseyNumber: 1000 }, coachA.token)).status, 400);
  assert.equal((await t.api('PATCH', path, { status: 'pending' }, coachA.token)).status, 400);
  assert.equal((await t.api('PATCH', `/api/teams/${teamA.id}/roster/${omar.user.id}`, { position: 'x' }, coachA.token)).status, 404, 'not on this team');
  const unchanged = await t.api('PATCH', path, {}, coachA.token);
  assert.equal(unchanged.status, 200);
});

test('the coach can remove a player or reject a request; a missing player is 404', async () => {
  await t.api('POST', `/api/teams/${teamB.id}/join-requests`, {}, noah.token);
  const rejected = await t.api('DELETE', `/api/teams/${teamB.id}/roster/${noah.user.id}`, undefined, coachB.token);
  assert.equal(rejected.status, 200);
  assert.deepEqual(names(await roster(teamB, coachB.token, 'pending')), []);

  assert.equal((await t.api('DELETE', `/api/teams/${teamA.id}/roster/${mia.user.id}`, undefined, coachA.token)).status, 200);
  assert.equal((await t.api('DELETE', `/api/teams/${teamA.id}/roster/${mia.user.id}`, undefined, coachA.token)).status, 404);
  assert.equal((await t.api('GET', `/api/teams/${teamA.id}`, undefined, noah.token)).body.team.playerCount, 2);
});

test('a learner can leave a team or cancel their own request', async () => {
  const left = await t.api('DELETE', `/api/teams/${teamA.id}/membership`, undefined, lena.token);
  assert.equal(left.status, 200);
  assert.equal((await t.api('DELETE', `/api/teams/${teamA.id}/membership`, undefined, lena.token)).status, 404);
  assert.equal((await roster(teamA, lena.token)).status, 403, 'no longer sees the roster');

  await t.api('POST', `/api/teams/${teamA.id}/join-requests`, {}, lena.token);
  assert.equal((await t.api('DELETE', `/api/teams/${teamA.id}/membership`, undefined, lena.token)).status, 200, 'cancel a pending request');
  assert.deepEqual((await t.api('GET', '/api/me/teams', undefined, lena.token)).body.teams, []);
});

test('a learner can be on several teams', async () => {
  await t.api('POST', `/api/teams/${teamA.id}/join-requests`, {}, noah.token); // already active, expect 409
  await t.api('POST', `/api/teams/${teamB.id}/join-requests`, {}, noah.token);
  const mine = await t.api('GET', '/api/me/teams', undefined, noah.token);
  assert.deepEqual(mine.body.teams.map((x) => [x.team.name, x.status]), [['Alpha Boys', 'active'], ['Bravo Boys', 'pending']]);
});

test('the database blocks duplicate numbers and duplicate membership', async () => {
  await assert.rejects(
    t.pool.query("INSERT INTO team_members (team_id, user_id, status, jersey_number) VALUES ($1, $2, 'active', 3)", [teamA.id, omar.user.id]),
    { code: '23505' }
  );
  await assert.rejects(
    t.pool.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [teamA.id, noah.user.id]),
    { code: '23505' }
  );
  await assert.rejects(
    t.pool.query("INSERT INTO team_members (team_id, user_id, status) VALUES ($1, $2, 'banned')", [teamB.id, noah.user.id]),
    { code: '23514' }
  );
});

test('removing a team or a user cleans up their memberships', async () => {
  await t.pool.query('DELETE FROM users WHERE id = $1', [noah.user.id]);
  const rows = await t.pool.query('SELECT count(*)::int n FROM team_members WHERE user_id = $1', [noah.user.id]);
  assert.equal(rows.rows[0].n, 0);
});
