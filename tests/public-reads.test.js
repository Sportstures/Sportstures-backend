const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, learnerPayload } = require('./helpers/setup');

let t;
let coachA, coachB, learner;
let teamA, teamB;
let league, fixture;

const anon = (path) => t.api('GET', path);

before(async () => {
  t = await startTestApp();
  const basketball = (name, school) => ({ school, team: { name, level: '1st_team', sport: 'Basketball' } });
  coachA = await signUpCoach(t, { email: 'a@example.com', ...basketball('Alpha Boys', 'Alpha High') });
  coachB = await signUpCoach(t, { email: 'b@example.com', ...basketball('Bravo Boys', 'Bravo High') });
  learner = await signUpLearner(t, learnerPayload({ email: 'learner@example.com', sport: null }));
  const mine = async (coach) => (await t.api('GET', '/api/teams?mine=true', undefined, coach.token)).body.teams[0];
  teamA = await mine(coachA);
  teamB = await mine(coachB);
  league = (await t.api('POST', '/api/competitions', { name: 'Schools League', sportId: teamA.sport.id }, coachA.token)).body.competition;
  fixture = (await t.api('POST', '/api/fixtures', {
    homeTeamId: teamA.id, awayTeamId: teamB.id, matchDate: '2026-09-01T15:00:00Z', competitionId: league.id,
  }, coachA.token)).body.fixture;
  await t.api('PUT', `/api/fixtures/${fixture.id}/result`, { homeScore: 3, awayScore: 1 }, coachA.token);
});
after(async () => { await t.stop(); });

test('visitors can read fixtures, results, competitions, standings and teams without logging in', async () => {
  const list = await anon('/api/fixtures?when=past');
  assert.equal(list.status, 200);
  assert.equal(list.body.fixtures[0].score.home, 3);
  assert.equal((await anon(`/api/fixtures/${fixture.id}`)).status, 200);
  assert.equal((await anon('/api/competitions')).body.competitions.length, 1);
  assert.equal((await anon(`/api/competitions/${league.id}/standings`)).status, 200);
  assert.equal((await anon('/api/teams')).body.teams.length, 2);
  assert.equal((await anon(`/api/teams/${teamA.id}`)).status, 200);
  assert.equal((await anon(`/api/teams/${teamA.id}/record`)).body.record.won, 1);
  assert.equal((await anon('/api/sports')).status, 200);
});

test('missing things are still 404, bad input still 400, for visitors', async () => {
  assert.equal((await anon('/api/fixtures/99999')).status, 404);
  assert.equal((await anon('/api/teams/99999')).status, 404);
  assert.equal((await anon('/api/fixtures?status=nonsense')).status, 400);
});

test('"mine" needs a login, and works with one', async () => {
  for (const path of ['/api/fixtures?mine=true', '/api/teams?mine=true']) {
    const res = await anon(path);
    assert.equal(res.status, 401, path);
    assert.equal(res.body.error.code, 'NO_TOKEN');
  }
  assert.equal((await t.api('GET', '/api/fixtures?mine=true', undefined, coachA.token)).body.fixtures.length, 1);
  assert.equal((await t.api('GET', '/api/fixtures?mine=true', undefined, learner.token)).body.fixtures.length, 0);
});

test('a token that IS sent must still be valid, so clients can refresh an expired one', async () => {
  const bad = await t.api('GET', '/api/fixtures', undefined, 'not-a-real-token');
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.code, 'INVALID_TOKEN');
});

test('private things stay private: rosters, join requests, candidates, lineups before kick-off, reports, writes', async () => {
  assert.equal((await anon(`/api/teams/${teamA.id}/roster`)).status, 401);
  assert.equal((await anon(`/api/teams/${teamA.id}/candidates`)).status, 401);
  assert.equal((await anon('/api/me/teams')).status, 401);
  assert.equal((await anon(`/api/fixtures/${fixture.id}/lineups`)).status, 401);
  assert.equal((await anon(`/api/fixtures/${fixture.id}/report`)).status, 401);
  assert.equal((await t.api('POST', '/api/fixtures', {})).status, 401);
  assert.equal((await t.api('PUT', `/api/fixtures/${fixture.id}/result`, { homeScore: 0, awayScore: 0 })).status, 401);
  assert.equal((await t.api('POST', '/api/teams', { name: 'x' })).status, 401);
});

test('a visitor sees the same data as a logged-in user', async () => {
  const visitor = await anon('/api/fixtures');
  const member = await t.api('GET', '/api/fixtures', undefined, learner.token);
  assert.deepEqual(visitor.body, member.body);
});
