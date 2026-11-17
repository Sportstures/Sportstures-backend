// Following schools (PUT/DELETE /api/me/favorites/schools/:schoolId): every match of a followed school's
// teams shows in the feed (GET /api/fixtures?favorites=true and GET /api/results?favorites=true).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, learnerPayload } = require('./helpers/setup');

let t;
let learner;
const teams = {};
const schools = {};

const feed = async (token = learner.token) => {
  const res = await t.api('GET', '/api/fixtures?favorites=true', undefined, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.fixtures.map((f) => `${f.homeTeam.name} v ${f.awayTeam.name}`).sort();
};
const follow = (schoolId, on = true) => t.api(on ? 'PUT' : 'DELETE', `/api/me/favorites/schools/${schoolId}`, undefined, learner.token);

before(async () => {
  t = await startTestApp();
  // Alpha High has two teams (netball and football); Bravo and Charlie High one each.
  const specs = [
    ['alphaNetball', 'Alpha High', 'Netball'], ['alphaFootball', 'Alpha High', 'Football'],
    ['bravoNetball', 'Bravo High', 'Netball'], ['charlieFootball', 'Charlie High', 'Football'],
    ['deltaFootball', 'Delta High', 'Football'],
  ];
  for (const [key, school, sport] of specs) {
    const coach = await signUpCoach(t, { email: `${key}@example.com`, school, team: { name: `${school} ${sport}`, level: '1st_team', sport } });
    teams[key] = { ...coach.user.team, token: coach.token };
    schools[school] = teams[key].school.id;
  }
  // Two played matches (with scores) and one still to come.
  const play = async (home, away, date, score) => {
    const res = await t.api('POST', '/api/fixtures', { homeTeamId: teams[home].id, awayTeamId: teams[away].id, matchDate: date }, teams[home].token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    if (score) {
      const scored = await t.api('PUT', `/api/fixtures/${res.body.fixture.id}/result`, { homeScore: score[0], awayScore: score[1] }, teams[home].token);
      assert.equal(scored.status, 200, JSON.stringify(scored.body));
    }
  };
  await play('alphaNetball', 'bravoNetball', '2026-01-10T10:00:00Z', [30, 25]);
  await play('charlieFootball', 'alphaFootball', '2026-01-11T10:00:00Z', [1, 2]);
  await play('charlieFootball', 'deltaFootball', '2099-05-01T10:00:00Z');
  learner = await signUpLearner(t, learnerPayload({ email: 'follower@example.com', sport: null }));
});

after(async () => {
  await t.stop();
});

test('following a school puts every match of its teams in the feed, home or away', async () => {
  assert.equal((await feed()).length, 3, 'nothing picked yet: every match');

  const res = await follow(schools['Alpha High']);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { schoolId: schools['Alpha High'], following: true });
  assert.equal((await follow(schools['Alpha High'])).status, 200, 'safe to repeat');

  assert.deepEqual(await feed(), [
    'Alpha High Netball v Bravo High Netball',
    'Charlie High Football v Alpha High Football',
  ]);
});

test('followed schools add to favourite teams and sports', async () => {
  await t.api('PUT', `/api/me/favorites/teams/${teams.deltaFootball.id}`, undefined, learner.token);
  assert.deepEqual(await feed(), [
    'Alpha High Netball v Bravo High Netball',
    'Charlie High Football v Alpha High Football',
    'Charlie High Football v Delta High Football',
  ]);
  await t.api('DELETE', `/api/me/favorites/teams/${teams.deltaFootball.id}`, undefined, learner.token);
});

test('the Results screen can show only my feed', async () => {
  const res = await t.api('GET', '/api/results?favorites=true&period=all', undefined, learner.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.summary.matchesPlayed, 2);

  await follow(schools['Alpha High'], false);
  await follow(schools['Bravo High']);
  const bravo = await t.api('GET', '/api/results?favorites=true', undefined, learner.token);
  assert.equal(bravo.body.summary.matchesPlayed, 1);
  assert.equal(bravo.body.days[0].results[0].awayTeam.school.name, 'Bravo High');

  assert.equal((await t.api('GET', '/api/results?favorites=true')).status, 401, 'needs a login');
  assert.equal((await t.api('GET', '/api/results')).body.summary.matchesPlayed, 2, 'without it, every result');
});

test('followed schools are listed and flagged on the school screens', async () => {
  const favs = await t.api('GET', '/api/me/favorites', undefined, learner.token);
  assert.deepEqual(favs.body.schools.map((s) => [s.name, s.following]), [['Bravo High', true]]);

  const list = await t.api('GET', '/api/schools', undefined, learner.token);
  const flags = Object.fromEntries(list.body.schools.map((s) => [s.name, s.following]));
  assert.equal(flags['Bravo High'], true);
  assert.equal(flags['Alpha High'], false);

  const mine = await t.api('GET', '/api/schools?following=true', undefined, learner.token);
  assert.deepEqual(mine.body.schools.map((s) => s.name), ['Bravo High']);
  assert.equal((await t.api('GET', '/api/schools?following=true')).status, 401);

  const page = await t.api('GET', `/api/schools/${schools['Bravo High']}`, undefined, learner.token);
  assert.equal(page.body.school.following, true);
  assert.equal((await t.api('GET', `/api/schools/${schools['Bravo High']}`)).body.school.following, false, 'signed out');
});

test('unfollowing removes the school; unknown schools are 404', async () => {
  const res = await follow(schools['Bravo High'], false);
  assert.deepEqual(res.body, { schoolId: schools['Bravo High'], following: false });
  assert.deepEqual((await t.api('GET', '/api/me/favorites', undefined, learner.token)).body.schools, []);
  assert.equal((await feed()).length, 3, 'back to every match');

  assert.equal((await follow(999999)).status, 404);
  assert.equal((await follow('abc')).status, 400);
  assert.equal((await t.api('PUT', `/api/me/favorites/schools/${schools['Bravo High']}`)).status, 401);
});
