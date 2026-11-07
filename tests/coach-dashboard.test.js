const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, makeAdmin, learnerPayload } = require('./helpers/setup');

let t;
let coachA, coachB, coachC, learner, admin;
let teamA, teamB;
let p1, p2, p3;

const dashboard = (token) => t.api('GET', '/api/coach/dashboard', undefined, token);
const types = (res) => res.body.actionItems.map((i) => i.type);
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();
const schedule = async (token, home, away, matchDate) => {
  const res = await t.api('POST', '/api/fixtures', { homeTeamId: home.id, awayTeamId: away.id, matchDate }, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.fixture;
};
const makeLearner = (email, firstName, school) => signUpLearner(t, learnerPayload({
  email, firstName, lastName: 'Player', school: { name: school, grade: 9, className: '9A' }, sport: null,
}));

before(async () => {
  t = await startTestApp();
  const basketball = (name, school) => ({ school, team: { name, level: '1st_team', sport: 'Basketball' } });
  coachA = await signUpCoach(t, { email: 'a@example.com', ...basketball('Alpha Boys', 'Alpha High') });
  coachB = await signUpCoach(t, { email: 'b@example.com', ...basketball('Bravo Boys', 'Bravo High') });
  coachC = await signUpCoach(t, { email: 'c@example.com', ...basketball('Charlie Boys', 'Charlie High') });
  learner = await makeLearner('learner@example.com', 'Lee', 'Alpha High');
  admin = await makeLearner('admin@example.com', 'Ad', 'Alpha High');
  await makeAdmin(t, 'admin@example.com');
  p1 = await makeLearner('p1@example.com', 'Pat', 'Alpha High');
  p2 = await makeLearner('p2@example.com', 'Quinn', 'Alpha High');
  p3 = await makeLearner('p3@example.com', 'Rae', 'Alpha High');
  const mine = async (coach) => (await t.api('GET', '/api/teams?mine=true', undefined, coach.token)).body.teams[0];
  teamA = await mine(coachA);
  teamB = await mine(coachB);
});
after(async () => { await t.stop(); });

test('only a coach can open the dashboard', async () => {
  assert.equal((await t.api('GET', '/api/coach/dashboard')).status, 401);
  assert.equal((await dashboard(learner.token)).status, 403);
  assert.equal((await dashboard(admin.token)).status, 403, 'admins have no team of their own');
});

test('a new coach sees their team and empty numbers, not errors', async () => {
  const res = await dashboard(coachA.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.team.name, 'Alpha Boys');
  assert.equal(res.body.team.sport.name, 'Basketball');
  assert.equal(res.body.squadSize, 0);
  assert.equal(res.body.pendingRequests, 0);
  assert.equal(res.body.record.played, 0);
  assert.equal(res.body.record.winRate, null);
  assert.equal(res.body.nextMatch, null);
  assert.deepEqual(res.body.upcoming, []);
  assert.deepEqual(res.body.recentResults, []);
  assert.deepEqual(res.body.actionItems, []);
});

test('a coach whose team was removed gets a clear 404', async () => {
  await t.pool.query('UPDATE teams SET coach_id = NULL WHERE id = $1', [teamB.id]);
  const res = await dashboard(coachB.token);
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'TEAM_NOT_FOUND');
  await t.pool.query('UPDATE teams SET coach_id = $1 WHERE id = $2', [coachB.user.id, teamB.id]);
});

test('squad size counts active players; waiting requests become an action item', async () => {
  for (const [p, n] of [[p1, 4], [p2, 9]]) {
    await t.api('POST', `/api/teams/${teamA.id}/roster`, { userId: p.user.id, jerseyNumber: n }, coachA.token);
  }
  await t.api('POST', `/api/teams/${teamA.id}/join-requests`, {}, p3.token);
  const res = await dashboard(coachA.token);
  assert.equal(res.body.squadSize, 2);
  assert.equal(res.body.pendingRequests, 1);
  assert.deepEqual(res.body.actionItems, [{ type: 'review_join_requests', dueAt: null, count: 1 }]);
  assert.equal((await dashboard(coachB.token)).body.squadSize, 0, 'another coach\'s team is separate');
});

test('an upcoming match shows as next match, and asks both coaches for a lineup', async () => {
  const soon = await schedule(coachA.token, teamA, teamB, inDays(2));
  const a = await dashboard(coachA.token);
  assert.equal(a.body.nextMatch.id, soon.id);
  assert.equal(a.body.upcoming.length, 1);
  const lineup = a.body.actionItems.find((i) => i.type === 'submit_lineup');
  assert.equal(lineup.fixture.id, soon.id);
  assert.ok(lineup.dueAt);

  const b = await dashboard(coachB.token);
  assert.equal(b.body.nextMatch.id, soon.id, 'the away team sees it too');
  assert.ok(types(b).includes('submit_lineup'));
  assert.equal(types(await dashboard(coachC.token)).length, 0, 'an unrelated coach sees nothing');
  assert.equal((await dashboard(coachC.token)).body.nextMatch, null);

  // Submitting a lineup clears it for that team only.
  const put = await t.api('PUT', `/api/fixtures/${soon.id}/lineups/${teamA.id}`, { starters: [{ userId: p1.user.id }] }, coachA.token);
  assert.equal(put.status, 200);
  assert.ok(!types(await dashboard(coachA.token)).includes('submit_lineup'));
  assert.ok(types(await dashboard(coachB.token)).includes('submit_lineup'));
});

test('a match more than a week away is upcoming but does not ask for a lineup yet', async () => {
  const later = await schedule(coachA.token, teamA, teamB, inDays(20));
  const res = await dashboard(coachA.token);
  assert.equal(res.body.upcoming.length, 2);
  assert.deepEqual(res.body.upcoming.map((f) => f.id).slice(-1), [later.id], 'soonest first');
  assert.equal(res.body.actionItems.filter((i) => i.type === 'submit_lineup').length, 0);
});

test('a cancelled match is not upcoming and asks for nothing', async () => {
  const cancelled = await schedule(coachA.token, teamA, teamB, inDays(3));
  await t.api('PATCH', `/api/fixtures/${cancelled.id}`, { status: 'cancelled' }, coachA.token);
  const res = await dashboard(coachA.token);
  assert.ok(!res.body.upcoming.some((f) => f.id === cancelled.id));
  assert.ok(!res.body.actionItems.some((i) => i.fixture && i.fixture.id === cancelled.id));
});

test('a past match with no result asks the HOME coach to record it; then both to file a report', async () => {
  const played = await schedule(coachA.token, teamA, teamB, inDays(-2));

  const a = await dashboard(coachA.token);
  const record = a.body.actionItems.find((i) => i.type === 'record_result');
  assert.equal(record.fixture.id, played.id);
  assert.equal(a.body.actionItems[0].type, 'record_result', 'overdue results come first');
  assert.ok(!types(await dashboard(coachB.token)).includes('record_result'), 'the away coach cannot record it');
  assert.ok(!a.body.upcoming.some((f) => f.id === played.id), 'it is not upcoming');

  const result = await t.api('PUT', `/api/fixtures/${played.id}/result`, { homeScore: 70, awayScore: 55 }, coachA.token);
  assert.equal(result.status, 200, JSON.stringify(result.body));

  const after = await dashboard(coachA.token);
  assert.ok(!types(after).includes('record_result'));
  assert.ok(types(after).includes('file_report'));
  assert.ok(types(await dashboard(coachB.token)).includes('file_report'), 'either coach can file it');
  assert.equal(after.body.recentResults[0].id, played.id);
  assert.deepEqual(after.body.recentResults[0].score, { home: 70, away: 55 });
  assert.equal(after.body.record.played, 1);
  assert.equal(after.body.record.won, 1);
  assert.equal(after.body.record.winRate, 100, 'a percentage');

  const b = await dashboard(coachB.token);
  assert.equal(b.body.record.lost, 1, 'the same match is a loss for the other team');

  await t.api('PUT', `/api/fixtures/${played.id}/report`, { summary: 'Good game' }, coachB.token);
  assert.ok(!types(await dashboard(coachA.token)).includes('file_report'));
  assert.ok(!types(await dashboard(coachB.token)).includes('file_report'));
});

test('old finished matches no longer ask for a report', async () => {
  const old = await schedule(coachA.token, teamA, teamB, inDays(-60));
  await t.api('PUT', `/api/fixtures/${old.id}/result`, { homeScore: 1, awayScore: 0 }, coachA.token);
  const res = await dashboard(coachA.token);
  assert.ok(!res.body.actionItems.some((i) => i.fixture && i.fixture.id === old.id));
  assert.equal(res.body.record.played, 2, 'but it still counts in the record');
});

test('action items are ordered: results, lineups, reports, requests', async () => {
  const overdue = await schedule(coachA.token, teamA, teamB, inDays(-1));
  const res = await dashboard(coachA.token);
  const order = types(res);
  assert.equal(order[0], 'record_result');
  assert.equal(order.at(-1), 'review_join_requests');
  assert.ok(order.indexOf('submit_lineup') === -1 || order.indexOf('record_result') < order.indexOf('submit_lineup'));
  assert.ok(res.body.actionItems.some((i) => i.fixture && i.fixture.id === overdue.id));
});
