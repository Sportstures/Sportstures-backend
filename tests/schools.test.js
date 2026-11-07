const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, makeAdmin, learnerPayload, coachPayload } = require('./helpers/setup');

let t;
let coachA, coachB, learner, admin;
let alpha, bravo;

const schools = (qs = '') => t.api('GET', `/api/schools${qs}`);
const byName = async (name) => (await schools(`?q=${encodeURIComponent(name)}`)).body.schools.find((s) => s.name === name);

before(async () => {
  t = await startTestApp();
  const basketball = (name, school) => ({ school, team: { name, level: '1st_team', sport: 'Basketball' } });
  // Alpha High signs up with a province and town; Bravo High with none.
  coachA = await signUpCoach(t, { email: 'a@example.com', ...basketball('Alpha Boys', 'Alpha High'), schoolProvince: 'Gauteng', schoolTown: 'Sandton' });
  coachB = await signUpCoach(t, { email: 'b@example.com', ...basketball('Bravo Boys', 'Bravo High') });
  learner = await signUpLearner(t, learnerPayload({ email: 'learner@example.com', sport: null }));
  admin = await signUpLearner(t, learnerPayload({ email: 'admin@example.com', sport: null }));
  await makeAdmin(t, 'admin@example.com');
  alpha = await byName('Alpha High');
  bravo = await byName('Bravo High');
});
after(async () => { await t.stop(); });

test('a coach can give the school\'s province and town at signup; it is optional', () => {
  assert.equal(alpha.province, 'Gauteng');
  assert.equal(alpha.town, 'Sandton');
  assert.equal(bravo.province, null);
  assert.equal(bravo.town, null);
});

test('a learner can give the school\'s province and town at signup', async () => {
  const payload = learnerPayload({
    email: 'cara@example.com', sport: null,
    school: { name: 'Charlie High', grade: 9, className: '9A', province: 'Western Cape', town: 'Cape Town' },
  });
  assert.equal((await t.api('POST', '/api/auth/register', payload)).status, 201);
  const charlie = await byName('Charlie High');
  assert.equal(charlie.province, 'Western Cape');
  assert.equal(charlie.town, 'Cape Town');
});

test('an unknown province is rejected at signup', async () => {
  const learnerBad = await t.api('POST', '/api/auth/register', learnerPayload({
    email: 'bad1@example.com', sport: null, school: { name: 'X High', grade: 9, className: '9A', province: 'Narnia' },
  }));
  assert.equal(learnerBad.status, 400);
  const coachBad = await t.api('POST', '/api/auth/register/coach', coachPayload({ email: 'bad2@example.com', schoolProvince: 'Narnia' }));
  assert.equal(coachBad.status, 422);
  assert.ok(coachBad.body.errors.schoolProvince);
  assert.equal(await byName('X High'), undefined, 'nothing was created');
});

test('a later signup fills an empty location but never overwrites one', async () => {
  const signup = (email, province) => t.api('POST', '/api/auth/register', learnerPayload({
    email, sport: null, school: { name: 'alpha high', grade: 9, className: '9A', province, town: 'Elsewhere' },
  }));
  assert.equal((await signup('l1@example.com', 'Limpopo')).status, 201);
  const a = await byName('Alpha High');
  assert.equal(a.province, 'Gauteng', 'kept');
  assert.equal(a.town, 'Sandton', 'kept');

  assert.equal((await signup('l2@example.com', 'Free State')).status, 201);
  const b = await byName('Bravo High');
  assert.equal(b.province, null, 'a different school is unaffected');
  const bravoSignup = await t.api('POST', '/api/auth/register', learnerPayload({
    email: 'l3@example.com', sport: null, school: { name: 'Bravo High', grade: 9, className: '9A', province: 'Free State', town: 'Bloemfontein' },
  }));
  assert.equal(bravoSignup.status, 201);
  const filled = await byName('Bravo High');
  assert.equal(filled.province, 'Free State', 'an empty province is filled in');
  assert.equal(filled.town, 'Bloemfontein');
  // put it back for the permission tests below
  await t.pool.query("UPDATE schools SET province = NULL, town = NULL WHERE name = 'Bravo High'");
});

test('anyone can list schools; filter by province and search by name', async () => {
  const all = await schools();
  assert.equal(all.status, 200);
  assert.ok(all.body.schools.length >= 3);
  const gauteng = await schools('?province=Gauteng');
  assert.deepEqual(gauteng.body.schools.map((s) => s.name), ['Alpha High']);
  assert.deepEqual((await schools('?q=brav')).body.schools.map((s) => s.name), ['Bravo High']);
  assert.equal((await schools('?province=Narnia')).status, 400);
});

test('a school shows its team count and sports', async () => {
  const a = await byName('Alpha High');
  assert.equal(a.teamCount, 1);
  assert.deepEqual(a.sports, ['Basketball']);
  const one = await t.api('GET', `/api/schools/${a.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.school.name, 'Alpha High');
  assert.equal((await t.api('GET', '/api/schools/99999')).status, 404);
  assert.equal((await t.api('GET', '/api/schools/abc')).status, 400);
});

test('team and fixture objects include the school\'s province and town', async () => {
  const team = (await t.api('GET', '/api/teams?mine=true', undefined, coachA.token)).body.teams[0];
  assert.deepEqual(team.school, { id: alpha.id, name: 'Alpha High', province: 'Gauteng', town: 'Sandton' });
  const teamB = (await t.api('GET', '/api/teams?mine=true', undefined, coachB.token)).body.teams[0];
  const fx = await t.api('POST', '/api/fixtures', { homeTeamId: team.id, awayTeamId: teamB.id, matchDate: '2099-01-01T15:00:00Z' }, coachA.token);
  assert.equal(fx.body.fixture.homeTeam.school.province, 'Gauteng');
  assert.equal(fx.body.fixture.awayTeam.school.province, null);
});

test('editing a school: its coach or an admin only', async () => {
  const patch = (school, body, token) => t.api('PATCH', `/api/schools/${school.id}`, body, token);
  assert.equal((await patch(bravo, { province: 'Gauteng' }, coachA.token)).status, 403, 'another school\'s coach');
  assert.equal((await patch(bravo, { province: 'Gauteng' }, learner.token)).status, 403);
  assert.equal((await patch(bravo, { province: 'Gauteng' })).status, 401);

  const own = await patch(bravo, { province: 'Free State', town: 'Bloemfontein' }, coachB.token);
  assert.equal(own.status, 200);
  assert.deepEqual([own.body.school.province, own.body.school.town], ['Free State', 'Bloemfontein']);

  const byAdmin = await patch(bravo, { town: 'Welkom' }, admin.token);
  assert.equal(byAdmin.status, 200);
  assert.equal(byAdmin.body.school.town, 'Welkom');
  assert.equal(byAdmin.body.school.province, 'Free State', 'only the fields sent change');

  const cleared = await patch(bravo, { province: null, town: null }, admin.token);
  assert.equal(cleared.body.school.province, null);
  assert.equal(cleared.body.school.town, null);

  assert.equal((await patch(bravo, { province: 'Narnia' }, admin.token)).status, 400);
  assert.equal((await t.api('PATCH', '/api/schools/99999', { town: 'x' }, admin.token)).status, 404);
});

test('the database rejects an unknown province', async () => {
  await assert.rejects(t.pool.query("UPDATE schools SET province = 'Narnia' WHERE id = $1", [alpha.id]), { code: '23514' });
});
