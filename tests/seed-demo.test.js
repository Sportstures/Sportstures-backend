const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach } = require('./helpers/setup');
const { seedDemo, DEMO_DOMAIN, DEMO_PASSWORD } = require('../scripts/seed-demo');

let t;
let real; // a real (non-demo) coach whose data the seed must never touch

const count = async (sql, params) => (await t.pool.query(sql, params)).rows[0].n;
const demoUsers = () => count('SELECT count(*)::int AS n FROM users WHERE email LIKE $1', [`%@${DEMO_DOMAIN}`]);

before(async () => {
  t = await startTestApp();
  // A real school that shares a name with a demo school, and has its own team and province.
  real = await signUpCoach(t, {
    email: 'real@example.com', school: 'Northview High', schoolProvince: 'Limpopo', schoolTown: 'Polokwane',
    team: { name: 'Real Northview Basketball', level: '1st_team', sport: 'Basketball' },
  });
});
after(async () => { await t.stop(); });

test('adds schools, teams, fixtures and results', async () => {
  const result = await seedDemo(t.pool);
  assert.equal(result.skipped, false);
  assert.equal(result.schools, 8);
  assert.equal(result.teams, 32);
  assert.ok(result.fixtures > 50);
  assert.ok(result.results > 20 && result.results < result.fixtures);
  assert.equal(await demoUsers(), 33, '32 coaches and 1 learner');
});

test('running it again does nothing', async () => {
  const before = await count('SELECT count(*)::int AS n FROM fixtures');
  const again = await seedDemo(t.pool);
  assert.equal(again.skipped, true);
  assert.equal(await count('SELECT count(*)::int AS n FROM fixtures'), before);
});

test('the public pages have data: results, upcoming fixtures, standings, schools by province', async () => {
  const past = await t.api('GET', '/api/fixtures?when=past&limit=100');
  assert.ok(past.body.fixtures.length > 20);
  assert.ok(past.body.fixtures.every((f) => f.score && f.status === 'finished'));
  const upcoming = await t.api('GET', '/api/fixtures?when=upcoming&limit=100');
  assert.ok(upcoming.body.fixtures.length > 10);
  assert.ok(upcoming.body.fixtures.every((f) => new Date(f.matchDate) > new Date()));

  const comps = (await t.api('GET', '/api/competitions')).body.competitions;
  assert.equal(comps.length, 7);
  const football = comps.find((c) => c.name.endsWith('Football'));
  const table = (await t.api('GET', `/api/competitions/${football.id}/standings`)).body;
  assert.ok(table.standings.length >= 5);
  assert.ok(table.standings[0].points >= table.standings.at(-1).points);

  const provinces = new Set((await t.api('GET', '/api/schools?limit=100')).body.schools.map((s) => s.province));
  assert.ok(['Gauteng', 'Western Cape', 'KwaZulu-Natal', 'Free State'].every((p) => provinces.has(p)));
});

test('scores fit their sport and a sport without draws has none', async () => {
  const rows = await t.pool.query(
    `SELECT sp.name AS sport, sc.home_team_score AS h, sc.away_team_score AS a
       FROM scores sc JOIN fixtures f ON f.id = sc.fixture_id JOIN teams tm ON tm.id = f.home_team_id JOIN sports sp ON sp.id = tm.sport_id`);
  assert.ok(rows.rows.length > 20);
  for (const r of rows.rows) {
    if (['Basketball', 'Cricket', 'Volleyball'].includes(r.sport)) assert.notEqual(r.h, r.a, `${r.sport} cannot end level`);
    if (r.sport === 'Football') assert.ok(r.h <= 4 && r.a <= 4);
  }
});

test('a demo coach and the demo learner can log in', async () => {
  const coach = await t.api('POST', '/api/auth/login', { email: `coach1@${DEMO_DOMAIN}`, password: DEMO_PASSWORD });
  assert.equal(coach.status, 200);
  assert.equal(coach.body.user.role, 'coach');
  const learner = await t.api('POST', '/api/auth/login', { email: `learner@${DEMO_DOMAIN}`, password: DEMO_PASSWORD });
  assert.equal(learner.status, 200);
  const mine = await t.api('GET', '/api/me/teams', undefined, learner.body.accessToken);
  assert.equal(mine.body.teams[0].status, 'active');
  assert.equal(mine.body.teams[0].jerseyNumber, 7);
});

test('--reset removes only the demo data and rebuilds it, leaving real data alone', async () => {
  const realTeams = await count("SELECT count(*)::int AS n FROM teams WHERE name = 'Real Northview Basketball'");
  const reset = await seedDemo(t.pool, { reset: true });
  assert.equal(reset.skipped, false);
  assert.equal(await demoUsers(), 33, 'rebuilt, not duplicated');
  assert.equal(await count('SELECT count(*)::int AS n FROM competitions'), 7);

  assert.equal(await count("SELECT count(*)::int AS n FROM teams WHERE name = 'Real Northview Basketball'"), realTeams);
  assert.equal(await count("SELECT count(*)::int AS n FROM users WHERE email = 'real@example.com'"), 1);
  const northview = (await t.api('GET', '/api/schools?q=Northview')).body.schools[0];
  assert.equal(northview.province, 'Limpopo', 'the real school keeps its own province');
  assert.equal(northview.town, 'Polokwane');
});

test('a reset with a real team at a demo school keeps that school; unused demo schools go', async () => {
  // Remove the demo data entirely: the Northview High row must stay (the real team uses it).
  await t.pool.query('DELETE FROM fixtures WHERE home_team_id IN (SELECT id FROM teams WHERE coach_id IN (SELECT id FROM users WHERE email LIKE $1))', [`%@${DEMO_DOMAIN}`]);
  const { removeDemoData } = require('../scripts/seed-demo');
  assert.ok(await removeDemoData(t.pool) > 0);
  assert.equal(await demoUsers(), 0);
  const names = (await t.api('GET', '/api/schools?limit=100')).body.schools.map((s) => s.name);
  assert.deepEqual(names, ['Northview High']);
});
