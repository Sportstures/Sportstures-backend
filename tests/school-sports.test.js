// The learner's school sports (GET /api/me/school-sports) and adding teams from other schools
// (GET /api/teams?otherSchools=true, then PUT /api/me/favorites/teams/:id).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner } = require('./helpers/setup');

let t;
let learner;
const teams = {};

before(async () => {
  t = await startTestApp();
  // Jeppe High (the learner's school): netball, football and basketball. Northview High: netball.
  const coaches = [
    ['jeppeNetball', 'jn@example.com', 'Jeppe High', { name: 'Jeppe Netball U16', level: 'u16', sport: 'Netball' }],
    ['jeppeFootball', 'jf@example.com', ' jeppe high ', { name: 'Jeppe Football 1st', level: '1st_team', sport: 'Soccer' }],
    ['jeppeBasketball', 'jb@example.com', 'JEPPE HIGH', { name: 'Jeppe Basketball', level: 'u19', sport: 'Basketball' }],
    ['northNetball', 'nn@example.com', 'Northview High', { name: 'Northview Netball', level: 'u16', sport: 'Netball' }],
  ];
  for (const [key, email, school, team] of coaches) {
    const coach = await signUpCoach(t, { email, school, team });
    teams[key] = { ...coach.user.team, coachToken: coach.token };
  }
  learner = await signUpLearner(t, { email: 'schoolsports@example.com' }); // Jeppe High, declared sport Netball
});

after(async () => {
  await t.stop();
});

const schoolSports = async (token = learner.token) => {
  const res = await t.api('GET', '/api/me/school-sports', undefined, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

test('the learner sees their school\'s sports, with their own sport first and teams under each', async () => {
  const body = await schoolSports();
  assert.equal(body.school.name, 'Jeppe High');
  assert.deepEqual(body.sports.map((s) => s.sport.name), ['Netball', 'Basketball', 'Football']);
  assert.deepEqual(body.sports.map((s) => s.mySport), [true, false, false]);
  assert.deepEqual(body.sports[0].teams.map((tm) => tm.name), ['Jeppe Netball U16']);
  assert.ok(!JSON.stringify(body.sports).includes('Northview'), 'other schools are not mixed in');

  const team = body.sports[0].teams[0];
  assert.equal(team.school.name, 'Jeppe High');
  assert.equal(team.coach.name, 'Sipho Williams');
  assert.equal(team.favorite, false);
  assert.equal(team.membership, null);
  assert.deepEqual(body.addedTeams, []);
});

test('teams show the learner\'s join request and membership', async () => {
  const join = await t.api('POST', `/api/teams/${teams.jeppeNetball.id}/join-requests`, {}, learner.token);
  assert.equal(join.status, 201, JSON.stringify(join.body));
  let body = await schoolSports();
  assert.equal(body.sports[0].teams[0].membership, 'pending');

  const approved = await t.api('PATCH', `/api/teams/${teams.jeppeNetball.id}/roster/${learner.user.id}`,
    { status: 'active' }, teams.jeppeNetball.coachToken);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  body = await schoolSports();
  assert.equal(body.sports[0].teams[0].membership, 'active');
});

test('the learner finds and adds teams from other schools', async () => {
  const search = await t.api('GET', '/api/teams?otherSchools=true&favorites=false', undefined, learner.token);
  assert.equal(search.status, 200, JSON.stringify(search.body));
  assert.deepEqual(search.body.teams.map((tm) => tm.name), ['Northview Netball'], 'only other schools\' teams');

  const sportFiltered = await t.api('GET', `/api/teams?otherSchools=true&sportId=${teams.jeppeBasketball.sport.id}`, undefined, learner.token);
  assert.deepEqual(sportFiltered.body.teams, []);

  const added = await t.api('PUT', `/api/me/favorites/teams/${teams.northNetball.id}`, undefined, learner.token);
  assert.equal(added.status, 200);

  const body = await schoolSports();
  assert.deepEqual(body.addedTeams.map((tm) => [tm.name, tm.school.name, tm.favorite]), [['Northview Netball', 'Northview High', true]]);

  const after = await t.api('GET', '/api/teams?otherSchools=true&favorites=false', undefined, learner.token);
  assert.deepEqual(after.body.teams, [], 'added teams drop out of the "add" list');

  await t.api('DELETE', `/api/me/favorites/teams/${teams.northNetball.id}`, undefined, learner.token);
  assert.deepEqual((await schoolSports()).addedTeams, []);
});

test('favouriting a team at their own school marks it there, not under added teams', async () => {
  await t.api('PUT', `/api/me/favorites/teams/${teams.jeppeFootball.id}`, undefined, learner.token);
  const body = await schoolSports();
  const football = body.sports.find((s) => s.sport.name === 'Football');
  assert.equal(football.teams[0].favorite, true);
  assert.deepEqual(body.addedTeams, []);
});

test('a coach gets their own school too; both need a login', async () => {
  const body = await schoolSports(teams.northNetball.coachToken);
  assert.equal(body.school.name, 'Northview High');
  assert.deepEqual(body.sports.map((s) => [s.sport.name, s.mySport]), [['Netball', false]]);

  assert.equal((await t.api('GET', '/api/me/school-sports')).status, 401);
  assert.equal((await t.api('GET', '/api/teams?otherSchools=true')).status, 401);
});
