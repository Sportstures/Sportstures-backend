// The learner Find Schools screen (/api/schools search and filters) and the school page (/api/schools/:id).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, learnerPayload } = require('./helpers/setup');

let t;
const teams = {}; // by key, with the coach's token
let learner;

const get = async (path, token) => {
  const res = await t.api('GET', path, undefined, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};
const names = (list) => list.map((x) => x.name);

before(async () => {
  t = await startTestApp();
  const specs = [
    // key, school, sport, province, town
    ['alphaB', 'Alpha High', 'Basketball', 'Gauteng', 'Sandton'],
    ['alphaN', 'Alpha High', 'Netball'],
    ['alphaB2', 'Alpha High', 'Basketball', null, null, 'Seconds'],
    ['bravo', 'Bravo High', 'Basketball', 'Western Cape', 'Cape Town'],
    ['charlie', 'Charlie College', 'Netball', 'Gauteng', 'Pretoria'],
  ];
  for (const [key, school, sport, schoolProvince, schoolTown, suffix] of specs) {
    const coach = await signUpCoach(t, {
      email: `${key}@example.com`, school, schoolProvince, schoolTown,
      team: { name: [school, sport, suffix].filter(Boolean).join(' '), level: '1st_team', sport },
    });
    teams[key] = { ...(await get('/api/teams?mine=true', coach.token)).teams[0], token: coach.token };
  }
  const play = async (home, away, matchDate, homeScore, awayScore) => {
    const res = await t.api('POST', '/api/fixtures', { homeTeamId: teams[home].id, awayTeamId: teams[away].id, matchDate }, teams[home].token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    if (homeScore !== undefined) {
      const done = await t.api('PUT', `/api/fixtures/${res.body.fixture.id}/result`, { homeScore, awayScore }, teams[home].token);
      assert.equal(done.status, 200, JSON.stringify(done.body));
    }
  };
  await play('alphaB', 'bravo', '2026-09-01T15:00:00Z', 3, 1); // Alpha win
  await play('bravo', 'alphaB', '2026-09-08T15:00:00Z', 2, 2); // draw
  await play('alphaB', 'alphaB2', '2026-09-10T15:00:00Z', 5, 0); // same school: not counted
  await play('charlie', 'alphaN', '2099-03-01T10:00:00Z'); // upcoming

  learner = await signUpLearner(t, learnerPayload({
    email: 'learner@example.com', sport: null, school: { name: 'bravo high', grade: 10, className: '10A' },
  }));
});
after(async () => { await t.stop(); });

test('searching schools by name or town, with paging totals', async () => {
  const all = await get('/api/schools');
  assert.deepEqual(names(all.schools), ['Alpha High', 'Bravo High', 'Charlie College']);
  assert.deepEqual([all.total, all.hasMore], [3, false]);

  assert.deepEqual(names((await get('/api/schools?q=college')).schools), ['Charlie College'], 'name');
  assert.deepEqual(names((await get('/api/schools?q=cape%20town')).schools), ['Bravo High'], 'town');
  assert.deepEqual((await get('/api/schools?q=100%25')).schools, [], '% is plain text');

  const page = await get('/api/schools?limit=2&offset=1');
  assert.deepEqual([names(page.schools), page.total, page.hasMore], [['Bravo High', 'Charlie College'], 3, false]);
  const first = await get('/api/schools?limit=1');
  assert.deepEqual([first.total, first.hasMore], [3, true]);
});

test('filtering by province and by sport', async () => {
  assert.deepEqual(names((await get('/api/schools?province=Gauteng')).schools), ['Alpha High', 'Charlie College']);
  assert.deepEqual(names((await get(`/api/schools?sportId=${teams.alphaN.sport.id}`)).schools), ['Alpha High', 'Charlie College']);
  assert.deepEqual(
    names((await get(`/api/schools?province=Gauteng&sportId=${teams.bravo.sport.id}`)).schools), ['Alpha High']
  );
  assert.equal((await t.api('GET', '/api/schools?sportId=abc')).status, 400);
});

test('each school card shows its sports, team count and record against other schools', async () => {
  const [alpha, bravo, charlie] = (await get('/api/schools')).schools;
  assert.deepEqual([alpha.teamCount, alpha.sports], [3, ['Basketball', 'Netball']]);
  assert.deepEqual(alpha.record, { played: 2, won: 1, drawn: 1, lost: 0, winRate: 50 }, 'the Alpha v Alpha game is left out');
  assert.deepEqual(bravo.record, { played: 2, won: 0, drawn: 1, lost: 1, winRate: 0 });
  assert.deepEqual(charlie.record, { played: 0, won: 0, drawn: 0, lost: 0, winRate: null });
});

test('a learner\'s own school is marked, and mine=true finds it', async () => {
  const signedIn = (await get('/api/schools', learner.token)).schools;
  assert.deepEqual(signedIn.filter((s) => s.mySchool).map((s) => s.name), ['Bravo High']);
  assert.ok((await get('/api/schools')).schools.every((s) => !s.mySchool), 'anonymous');
  assert.deepEqual(names((await get('/api/schools?mine=true', learner.token)).schools), ['Bravo High']);
  assert.deepEqual(names((await get('/api/schools?mine=true', teams.charlie.token)).schools), ['Charlie College'], 'a coach too');
  assert.equal((await t.api('GET', '/api/schools?mine=true')).status, 401);
});

test('the filter chips count schools per province and sport', async () => {
  const { provinces, sports } = await get('/api/schools/filters');
  assert.equal(provinces.length, 9);
  assert.equal(provinces.find((p) => p.name === 'Gauteng').schoolCount, 2);
  assert.equal(provinces.find((p) => p.name === 'Limpopo').schoolCount, 0);
  assert.deepEqual(sports.map((s) => [s.name, s.schoolCount]), [['Basketball', 2], ['Netball', 2]], 'schools, not teams');
});

test('the school page: teams, latest results and next matches', async () => {
  const alphaId = teams.alphaB.school.id;
  await t.api('PUT', `/api/me/favorites/teams/${teams.alphaN.id}`, undefined, learner.token);

  const page = await get(`/api/schools/${alphaId}`, learner.token);
  assert.equal(page.school.name, 'Alpha High');
  assert.equal(page.school.mySchool, false);
  assert.deepEqual(page.teams.map((x) => [x.name, x.favorite]), [['Alpha High Basketball', false], ['Alpha High Basketball Seconds', false], ['Alpha High Netball', true]]);
  assert.deepEqual(page.recentResults.map((f) => f.matchDate.slice(0, 10)), ['2026-09-10', '2026-09-08', '2026-09-01'], 'newest first');
  assert.deepEqual(page.upcoming.map((f) => [f.homeTeam.school.name, f.awayTeam.school.name]), [['Charlie College', 'Alpha High']]);

  assert.equal((await get(`/api/schools/${alphaId}`)).teams.every((x) => x.favorite === false), true, 'anonymous');
  assert.equal((await t.api('GET', '/api/schools/99999')).status, 404);
});

test('fixtures can be filtered by school', async () => {
  const { fixtures } = await get(`/api/fixtures?schoolId=${teams.charlie.school.id}`);
  assert.deepEqual(fixtures.map((f) => f.homeTeam.name), ['Charlie College Netball']);
});
