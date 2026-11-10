// Favourite sports and teams (/api/me/favorites), the sports catalogue, and the favourites feed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, learnerPayload } = require('./helpers/setup');

let t;
let teams; // by key
let learner, other;

const me = (method, path, body, token = learner.token) => t.api(method, `/api/me/favorites${path}`, body, token);
const names = (list) => list.map((x) => x.name);

before(async () => {
  t = await startTestApp();
  teams = {};
  const specs = [
    ['alpha', 'Alpha High', 'Basketball'], ['delta', 'Delta High', 'Basketball'],
    ['bravo', 'Bravo High', 'Netball'], ['echo', 'Echo High', 'Netball'],
    ['charlie', 'Charlie High', 'Football'], ['foxtrot', 'Foxtrot High', 'Football'],
    ['kilo', 'Kilo High', 'Kabaddi'], // a sport typed in at signup, not in the catalogue
  ];
  for (const [key, school, sport] of specs) {
    const coach = await signUpCoach(t, { email: `${key}@example.com`, school, team: { name: `${school} ${sport}`, level: '1st_team', sport } });
    teams[key] = { ...(await t.api('GET', '/api/teams?mine=true', undefined, coach.token)).body.teams[0], token: coach.token };
  }
  for (const [home, away] of [['alpha', 'delta'], ['bravo', 'echo'], ['charlie', 'foxtrot']]) {
    const res = await t.api('POST', '/api/fixtures', { homeTeamId: teams[home].id, awayTeamId: teams[away].id, matchDate: '2099-05-01T10:00:00Z' }, teams[home].token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  learner = await signUpLearner(t, learnerPayload({ email: 'learner@example.com', sport: null }));
  other = await signUpLearner(t, learnerPayload({ email: 'other@example.com', sport: null }));
});
after(async () => { await t.stop(); });

test('the sports catalogue is grouped like the Favourite Sports screen, with the app\'s keys', async () => {
  const { categories } = (await t.api('GET', '/api/sports/categories')).body;
  assert.deepEqual(categories.map((c) => c.label), [
    'Team Sports', 'Athletics & Endurance', 'Racket Sports', 'Water Sports', 'Combat Sports',
    'Precision & Outdoor', 'Mind & Heritage', 'Other',
  ]);
  const team = categories[0].sports;
  assert.deepEqual(team.slice(0, 5).map((s) => s.key), ['football', 'rugby', 'netball', 'cricket', 'hockey']);
  assert.equal(team.find((s) => s.key === 'waterPolo').name, 'Water Polo');
  assert.equal(categories.find((c) => c.key === 'mind').sports.find((s) => s.key === 'dance').name, 'Dance Sport');
  assert.deepEqual(categories.at(-1).sports.map((s) => [s.name, s.key, s.category]), [['Kabaddi', null, 'other']]);
  assert.equal(categories.reduce((n, c) => n + c.sports.length, 0), 42, '41 catalogue sports and Kabaddi');

  const football = (await t.api('GET', '/api/sports')).body.sports.find((s) => s.name === 'Football');
  assert.deepEqual([football.key, football.category], ['football', 'team']);
});

test('picking sports by key or id, one tile at a time, safe to repeat', async () => {
  assert.deepEqual((await me('GET', '')).body, { sports: [], teams: [], competitions: [] });

  const netball = await me('PUT', '/sports/netball');
  assert.deepEqual([netball.status, netball.body.sport.name, netball.body.favorite], [200, 'Netball', true]);
  assert.equal((await me('PUT', '/sports/NETBALL')).status, 200, 'keys ignore case; repeating is fine');
  const swimmingId = (await t.api('GET', '/api/sports')).body.sports.find((s) => s.name === 'Swimming').id;
  await me('PUT', `/sports/${swimmingId}`);
  assert.deepEqual(names((await me('GET', '')).body.sports), ['Netball', 'Swimming'], 'catalogue order');

  assert.equal((await me('DELETE', `/sports/${swimmingId}`)).body.favorite, false);
  assert.deepEqual(names((await me('GET', '')).body.sports), ['Netball']);
  assert.deepEqual(names((await me('GET', '', undefined, other.token)).body.sports), [], 'favourites are per person');

  assert.equal((await me('PUT', '/sports/quidditch')).status, 404);
});

test('replacing every sport at once, and clearing them', async () => {
  const res = await me('PUT', '/sports', { sports: ['rugby', 'chess', 'rugby'] }, other.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(names(res.body.sports), ['Rugby', 'Chess']);

  const bad = await me('PUT', '/sports', { sports: ['rugby', 'quidditch'] }, other.token);
  assert.deepEqual([bad.status, bad.body.error.code, bad.body.error.details.sports], [400, 'UNKNOWN_SPORT', ['quidditch']]);
  assert.deepEqual(names((await me('GET', '', undefined, other.token)).body.sports), ['Rugby', 'Chess'], 'a bad list changes nothing');

  assert.deepEqual((await me('PUT', '/sports', { sports: [] }, other.token)).body.sports, []);
  assert.equal((await me('PUT', '/sports', { sports: 'rugby' }, other.token)).status, 400);
});

test('favourite teams show on the team list and team page', async () => {
  const on = await me('PUT', `/teams/${teams.alpha.id}`);
  assert.deepEqual([on.status, on.body], [200, { teamId: teams.alpha.id, favorite: true }]);
  assert.equal((await me('PUT', `/teams/${teams.alpha.id}`)).status, 200);

  const mine = (await me('GET', '')).body.teams;
  assert.deepEqual(names(mine), ['Alpha High Basketball']);
  assert.equal(mine[0].school.name, 'Alpha High');

  const listed = (await t.api('GET', '/api/teams', undefined, learner.token)).body.teams;
  assert.deepEqual(listed.filter((x) => x.favorite).map((x) => x.id), [teams.alpha.id]);
  assert.deepEqual((await t.api('GET', '/api/teams?favorites=true', undefined, learner.token)).body.teams.map((x) => x.id), [teams.alpha.id]);
  assert.equal((await t.api('GET', `/api/teams/${teams.alpha.id}`, undefined, learner.token)).body.team.favorite, true);
  assert.equal((await t.api('GET', `/api/teams/${teams.alpha.id}`)).body.team.favorite, false, 'anonymous');
  assert.equal((await t.api('GET', '/api/teams?favorites=true')).status, 401);

  assert.equal((await me('PUT', '/teams/99999')).status, 404);
  assert.equal((await me('PUT', '/teams/abc')).status, 400);
  await me('PUT', `/teams/${teams.kilo.id}`);
  assert.equal((await me('DELETE', `/teams/${teams.kilo.id}`)).body.favorite, false);
  assert.deepEqual(names((await me('GET', '')).body.teams), ['Alpha High Basketball']);
});

test('the Favourite Teams screen: "Your teams", then "Add teams" searched by school and sport', async () => {
  const get = async (path) => {
    const res = await t.api('GET', path, undefined, learner.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.teams;
  };
  // learner has starred Alpha High Basketball (previous test).
  const yours = await get('/api/teams?favorites=true');
  assert.deepEqual(yours.map((x) => [x.school.name, x.sport.name, x.ageGroup, x.favorite]), [['Alpha High', 'Basketball', 'Open', true]]);

  const add = await get('/api/teams?favorites=false');
  assert.equal(add.length, 6, 'every team except the starred one');
  assert.ok(add.every((x) => !x.favorite && x.id !== teams.alpha.id));

  const basketball = await get(`/api/teams?favorites=false&sportId=${teams.delta.sport.id}`);
  assert.deepEqual(basketball.map((x) => x.school.name), ['Delta High']);
  assert.deepEqual((await get('/api/teams?favorites=false&q=echo%20high')).map((x) => x.name), ['Echo High Netball'], 'school name');
  assert.deepEqual(await get('/api/teams?q=100%25'), [], '% is plain text');

  assert.equal((await t.api('GET', '/api/teams?favorites=false')).status, 401);
  assert.equal((await me('GET', '')).body.teams[0].favorite, true);
});

test('the favourites feed: favourite teams and sports, or everything with none picked', async () => {
  const feed = async (token) => {
    const res = await t.api('GET', '/api/fixtures?favorites=true', undefined, token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.fixtures.map((f) => f.homeTeam.school.name).sort();
  };
  // learner: Alpha (team) and Netball (sport).
  assert.deepEqual(await feed(learner.token), ['Alpha High', 'Bravo High']);
  assert.deepEqual(await feed(other.token), ['Alpha High', 'Bravo High', 'Charlie High'], 'no favourites: every match');
  assert.equal((await t.api('GET', '/api/fixtures?favorites=true')).status, 401);
});

test('followed competitions come back with the favourites, and favourites need a login', async () => {
  const league = (await t.api('POST', '/api/competitions', { name: 'Netball League' }, teams.bravo.token)).body.competition;
  await t.api('PUT', `/api/competitions/${league.id}/follow`, undefined, learner.token);
  assert.deepEqual(names((await me('GET', '')).body.competitions), ['Netball League']);

  assert.equal((await t.api('GET', '/api/me/favorites')).status, 401);
  assert.equal((await t.api('PUT', '/api/me/favorites/sports/netball')).status, 401);
});
