const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, makeAdmin, learnerPayload } = require('./helpers/setup');

let t;
let coachA, coachB, coachC, coachD, learner, admin;
let teamA, teamB, teamC, teamD;
let league, cup;
let f1, f2, f3, fFuture, fCancelled;

const mineTeam = async (coach) => (await t.api('GET', '/api/teams?mine=true', undefined, coach.token)).body.teams[0];
const schedule = async (token, home, away, matchDate, competitionId) => {
  const res = await t.api('POST', '/api/fixtures', { homeTeamId: home.id, awayTeamId: away.id, matchDate, competitionId }, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.fixture;
};

before(async () => {
  t = await startTestApp();
  const basketball = (name, school) => ({ school, team: { name, level: '1st_team', sport: 'Basketball' } });
  coachA = await signUpCoach(t, { email: 'a@example.com', ...basketball('Alpha Boys', 'Alpha High') });
  coachB = await signUpCoach(t, { email: 'b@example.com', ...basketball('Bravo Boys', 'Bravo High') });
  coachC = await signUpCoach(t, { email: 'c@example.com', ...basketball('Charlie Boys', 'Charlie High') });
  coachD = await signUpCoach(t, { email: 'd@example.com', ...basketball('Delta Boys', 'Delta High') });
  learner = await signUpLearner(t, learnerPayload({ email: 'learner@example.com' }));
  admin = await signUpLearner(t, learnerPayload({ email: 'admin@example.com' }));
  await makeAdmin(t, 'admin@example.com');
  [teamA, teamB, teamC, teamD] = await Promise.all([coachA, coachB, coachC, coachD].map(mineTeam));

  league = (await t.api('POST', '/api/competitions', { name: 'Schools League', sportId: teamA.sport.id }, coachA.token)).body.competition;
  cup = (await t.api('POST', '/api/competitions', { name: 'Schools Cup', sportId: teamA.sport.id }, coachA.token)).body.competition;

  // Three league fixtures in the past, one in the far future, one cancelled.
  f1 = await schedule(coachA.token, teamA, teamB, '2026-09-01T15:00:00Z', league.id); // A v B
  f2 = await schedule(coachB.token, teamB, teamC, '2026-09-08T15:00:00Z', league.id); // B v C
  f3 = await schedule(coachA.token, teamA, teamC, '2026-09-15T15:00:00Z', league.id); // A v C
  fFuture = await schedule(coachD.token, teamD, teamA, '2099-01-01T15:00:00Z', league.id); // D v A, not played
  fCancelled = await schedule(coachC.token, teamC, teamA, '2026-09-20T15:00:00Z', league.id);
  await t.api('PATCH', `/api/fixtures/${fCancelled.id}`, { status: 'cancelled' }, coachC.token);
});
after(async () => { await t.stop(); });

const result = (token, fixture, homeScore, awayScore) => t.api('PUT', `/api/fixtures/${fixture.id}/result`, { homeScore, awayScore }, token);

// ---------------------------------------------------------------- recording results

test('a result cannot be recorded for a match that has not been played yet', async () => {
  const res = await result(coachD.token, fFuture, 1, 0);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'FIXTURE_NOT_STARTED');
});

test('a cancelled fixture cannot have a result', async () => {
  const res = await result(coachC.token, fCancelled, 1, 0);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'FIXTURE_NOT_PLAYABLE');
});

test('result permissions and validation', async () => {
  assert.equal((await result(coachB.token, f1, 70, 60)).status, 403, 'the away coach cannot record');
  assert.equal((await result(coachC.token, f1, 70, 60)).status, 403, 'an unrelated coach cannot record');
  assert.equal((await result(learner.token, f1, 70, 60)).status, 403);
  assert.equal((await t.api('PUT', `/api/fixtures/${f1.id}/result`, { homeScore: 70, awayScore: 60 })).status, 401);
  assert.equal((await result(coachA.token, f1, -1, 60)).status, 400);
  assert.equal((await result(coachA.token, f1, 'seventy', 60)).status, 400);
  assert.equal((await t.api('PUT', `/api/fixtures/${f1.id}/result`, { homeScore: 70 }, coachA.token)).status, 400);
  assert.equal((await t.api('PUT', '/api/fixtures/99999/result', { homeScore: 1, awayScore: 0 }, admin.token)).status, 404);
  const untouched = await t.api('GET', `/api/fixtures/${f1.id}`, undefined, learner.token);
  assert.equal(untouched.body.fixture.status, 'scheduled', 'failed attempts changed nothing');
  assert.equal(untouched.body.fixture.score, null);
});

test('the home coach records a result: the fixture is finished, scored, with a winner', async () => {
  const res = await result(coachA.token, f1, 70, 60);
  assert.equal(res.status, 200);
  assert.equal(res.body.fixture.status, 'finished');
  assert.deepEqual(res.body.fixture.score, { home: 70, away: 60 });
  assert.equal(res.body.fixture.winner, 'home');
  assert.equal(res.body.fixture.reportFiled, false);
});

test('an admin can record results, and a draw has no winner side', async () => {
  const res = await result(admin.token, f2, 55, 55);
  assert.equal(res.status, 200);
  assert.equal(res.body.fixture.winner, 'draw');
  const away = await result(coachA.token, f3, 40, 50);
  assert.equal(away.body.fixture.winner, 'away');
});

test('a result can be corrected, and there is still only one score row', async () => {
  const wrong = await result(coachA.token, f3, 41, 50);
  assert.equal(wrong.status, 200);
  assert.deepEqual(wrong.body.fixture.score, { home: 41, away: 50 });
  const fixed = await result(coachA.token, f3, 40, 50);
  assert.deepEqual(fixed.body.fixture.score, { home: 40, away: 50 });
  const rows = await t.pool.query('SELECT count(*)::int n FROM scores WHERE fixture_id = $1', [f3.id]);
  assert.equal(rows.rows[0].n, 1);
});

test('finished fixtures cannot be edited with PATCH, but appear in the past list with their winner', async () => {
  assert.equal((await t.api('PATCH', `/api/fixtures/${f1.id}`, { venue: 'x' }, coachA.token)).status, 409);
  const past = await t.api('GET', `/api/fixtures?when=past&competitionId=${league.id}`, undefined, learner.token);
  assert.deepEqual(past.body.fixtures.map((f) => [f.id, f.winner]), [[f3.id, 'away'], [f2.id, 'draw'], [f1.id, 'home']], 'newest first');
});

// ---------------------------------------------------------------- standings

test('league table: points, positions, form, and only finished matches count', async () => {
  const res = await t.api('GET', `/api/competitions/${league.id}/standings`, undefined, learner.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.competition.name, 'Schools League');

  const rows = res.body.standings;
  // Charlie: W1 D1 = 4 pts (+10). Alpha: W1 L1 = 3 (0). Bravo: D1 L1 = 1 (-10). Delta: no games, 0.
  assert.deepEqual(rows.map((r) => [r.position, r.team.name, r.played, r.won, r.drawn, r.lost, r.points]), [
    [1, 'Charlie Boys', 2, 1, 1, 0, 4],
    [2, 'Alpha Boys', 2, 1, 0, 1, 3],
    [3, 'Bravo Boys', 2, 0, 1, 1, 1],
    [4, 'Delta Boys', 0, 0, 0, 0, 0],
  ]);
  const alpha = rows[1];
  assert.equal(alpha.pointsFor, 110);
  assert.equal(alpha.pointsAgainst, 110);
  assert.equal(alpha.difference, 0);
  assert.deepEqual(alpha.form, ['W', 'L'], 'oldest first');
  assert.equal(rows[0].team.school.name, 'Charlie High');
  assert.equal(rows[0].team.sport.name, 'Basketball');
});

test('a team only in a cancelled fixture is not listed; scheduled-only competitions list everyone at zero', async () => {
  await schedule(coachA.token, teamA, teamB, '2099-02-01T15:00:00Z', cup.id);
  const res = await t.api('GET', `/api/competitions/${cup.id}/standings`, undefined, learner.token);
  assert.deepEqual(res.body.standings.map((r) => [r.position, r.team.name, r.played, r.points]), [
    [1, 'Alpha Boys', 0, 0],
    [1, 'Bravo Boys', 0, 0],
  ]);
});

test('standings for an empty or unknown competition', async () => {
  const empty = (await t.api('POST', '/api/competitions', { name: 'Empty League' }, coachA.token)).body.competition;
  const res = await t.api('GET', `/api/competitions/${empty.id}/standings`, undefined, learner.token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.standings, []);
  assert.equal((await t.api('GET', '/api/competitions/99999/standings', undefined, learner.token)).status, 404);
  assert.equal((await t.api('GET', '/api/competitions/abc/standings', undefined, learner.token)).status, 400);
  assert.equal((await t.api('GET', `/api/competitions/${league.id}/standings`)).status, 401);
});

// ---------------------------------------------------------------- team record

test('team record: win rate, averages and form for the season summary', async () => {
  const res = await t.api('GET', `/api/teams/${teamA.id}/record`, undefined, coachA.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.team.name, 'Alpha Boys');
  const r = res.body.record;
  assert.equal(r.played, 2);
  assert.equal(r.won, 1);
  assert.equal(r.lost, 1);
  assert.equal(r.winRate, 50);
  assert.equal(r.averageScored, 55);
  assert.equal(r.averageConceded, 55);
  assert.deepEqual(r.form, ['W', 'L']);
});

test('team record can be limited to one competition, and a team with no games has empty numbers', async () => {
  const inCup = await t.api('GET', `/api/teams/${teamA.id}/record?competitionId=${cup.id}`, undefined, learner.token);
  assert.equal(inCup.body.record.played, 0);
  assert.equal(inCup.body.record.winRate, null);
  const idle = await t.api('GET', `/api/teams/${teamD.id}/record`, undefined, learner.token);
  assert.equal(idle.body.record.played, 0);
  assert.deepEqual(idle.body.record.form, []);
  assert.equal((await t.api('GET', '/api/teams/99999/record', undefined, learner.token)).status, 404);
});

// ---------------------------------------------------------------- match reports

test('a report cannot be filed before the result is recorded', async () => {
  const res = await t.api('PUT', `/api/fixtures/${fFuture.id}/report`, { summary: 'Great game' }, coachD.token);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'FIXTURE_NOT_FINISHED');
});

test('either team\'s coach can file the one shared report; others cannot', async () => {
  assert.equal((await t.api('GET', `/api/fixtures/${f1.id}/report`, undefined, learner.token)).body.error.code, 'REPORT_NOT_FOUND');

  const filed = await t.api('PUT', `/api/fixtures/${f1.id}/report`, { summary: 'Alpha won a close game.' }, coachA.token);
  assert.equal(filed.status, 200);
  assert.equal(filed.body.report.summary, 'Alpha won a close game.');
  assert.equal(filed.body.report.author.id, coachA.user.id);

  const edited = await t.api('PUT', `/api/fixtures/${f1.id}/report`, { summary: 'Alpha won 70-60 after a strong fourth quarter.' }, coachB.token);
  assert.equal(edited.status, 200, 'the away coach may edit the shared report');
  assert.equal(edited.body.report.author.id, coachB.user.id);
  const count = await t.pool.query('SELECT count(*)::int n FROM fixture_reports WHERE fixture_id = $1', [f1.id]);
  assert.equal(count.rows[0].n, 1, 'still one report per fixture');

  assert.equal((await t.api('PUT', `/api/fixtures/${f1.id}/report`, { summary: 'x' }, coachC.token)).status, 403);
  assert.equal((await t.api('PUT', `/api/fixtures/${f1.id}/report`, { summary: 'x' }, learner.token)).status, 403);
  assert.equal((await t.api('PUT', `/api/fixtures/${f1.id}/report`, { summary: '   ' }, coachA.token)).status, 400);
  assert.equal((await t.api('PUT', '/api/fixtures/99999/report', { summary: 'x' }, admin.token)).status, 404);

  const read = await t.api('GET', `/api/fixtures/${f1.id}/report`, undefined, learner.token);
  assert.equal(read.status, 200);
  assert.match(read.body.report.summary, /fourth quarter/);
  assert.ok(read.body.report.updatedAt);
});

test('fixtures show whether a report has been filed', async () => {
  const withReport = await t.api('GET', `/api/fixtures/${f1.id}`, undefined, learner.token);
  assert.equal(withReport.body.fixture.reportFiled, true);
  const without = await t.api('GET', `/api/fixtures/${f2.id}`, undefined, learner.token);
  assert.equal(without.body.fixture.reportFiled, false);
});
