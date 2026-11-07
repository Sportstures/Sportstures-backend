const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, makeAdmin, learnerPayload } = require('./helpers/setup');

let t;
let sports;
let coachA, coachB, coachC, learner, admin;
let teamA, teamB, teamFootball;
let competition;

const sportId = (name) => sports.find((s) => s.name === name).id;

before(async () => {
  t = await startTestApp();
  sports = (await t.api('GET', '/api/sports')).body.sports;

  // Each coach is created with their one team during signup.
  coachA = await signUpCoach(t, { email: 'coacha@example.com', school: 'Jeppe High', team: { name: 'Basketball Boys', level: '1st_team', sport: 'Basketball' } });
  coachB = await signUpCoach(t, { email: 'coachb@example.com', school: 'Greenwood', team: { name: 'Greenwood Boys', level: '1st_team', sport: 'Basketball' } });
  coachC = await signUpCoach(t, { email: 'coachc@example.com', school: 'Jeppe High', team: { name: 'Football XI', level: 'u16', sport: 'Football' } });
  learner = await signUpLearner(t, learnerPayload({ email: 'learner@example.com' }));
  admin = await signUpLearner(t, learnerPayload({ email: 'admin@example.com' }));
  await makeAdmin(t, 'admin@example.com');

  const mine = async (coach) => (await t.api('GET', '/api/teams?mine=true', undefined, coach.token)).body.teams[0];
  teamA = await mine(coachA);
  teamB = await mine(coachB);
  teamFootball = await mine(coachC);
});
after(async () => { await t.stop(); });

// ---------------------------------------------------------------- teams

test('a coach\'s signup team is assigned to them, with sport, level and school', () => {
  assert.equal(teamA.name, 'Basketball Boys');
  assert.equal(teamA.coach.id, coachA.user.id);
  assert.equal(teamA.sport.name, 'Basketball');
  assert.equal(teamA.level, '1st_team');
  assert.equal(teamA.school.name, 'Jeppe High');
});

test('a coach can only have one team', async () => {
  const res = await t.api('POST', '/api/teams', { name: 'Basketball JV', sportId: sportId('Basketball') }, coachA.token);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'COACH_TEAM_EXISTS');
});

test('learners and anonymous users cannot create teams; admins can', async () => {
  assert.equal((await t.api('POST', '/api/teams', { name: 'Nope' }, learner.token)).status, 403);
  assert.equal((await t.api('POST', '/api/teams', { name: 'Nope' })).status, 401);
  const res = await t.api('POST', '/api/teams', { name: 'Rugby 1st XV', sportId: sportId('Rugby'), school: 'Jeppe High', genderCategory: 'Boys' }, admin.token);
  assert.equal(res.status, 201);
  assert.equal(res.body.team.coach, null);
  assert.equal(res.body.team.genderCategory, 'boys');
});

test('team validation', async () => {
  const badCategory = await t.api('POST', '/api/teams', { name: 'Bad', genderCategory: 'robots' }, admin.token);
  assert.equal(badCategory.status, 400);
  const badSport = await t.api('POST', '/api/teams', { name: 'Bad', sportId: 99999 }, admin.token);
  assert.equal(badSport.status, 400);
  assert.equal(badSport.body.error.code, 'UNKNOWN_SPORT');
  assert.equal((await t.api('POST', '/api/teams', {}, admin.token)).status, 400);
});

test('team list filters, search and paging', async () => {
  const footballOnly = await t.api('GET', `/api/teams?sportId=${sportId('Football')}`, undefined, learner.token);
  assert.deepEqual(footballOnly.body.teams.map((x) => x.name), ['Football XI']);

  const search = await t.api('GET', '/api/teams?q=green', undefined, learner.token);
  assert.deepEqual(search.body.teams.map((x) => x.name), ['Greenwood Boys']);

  const page = await t.api('GET', '/api/teams?limit=1&offset=1', undefined, learner.token);
  assert.equal(page.body.teams.length, 1);

  const mine = await t.api('GET', '/api/teams?mine=true', undefined, coachB.token);
  assert.deepEqual(mine.body.teams.map((x) => x.name), ['Greenwood Boys']);
});

test('get one team, missing team and bad id', async () => {
  assert.equal((await t.api('GET', `/api/teams/${teamA.id}`, undefined, learner.token)).body.team.name, 'Basketball Boys');
  assert.equal((await t.api('GET', '/api/teams/99999', undefined, learner.token)).status, 404);
  assert.equal((await t.api('GET', '/api/teams/abc', undefined, learner.token)).status, 400);
});

test('only the team\'s coach (or an admin) can edit a team; null clears a field', async () => {
  assert.equal((await t.api('PATCH', `/api/teams/${teamA.id}`, { location: 'x' }, coachB.token)).status, 403);

  const own = await t.api('PATCH', `/api/teams/${teamA.id}`, { location: 'Main Gym', description: 'Varsity side' }, coachA.token);
  assert.equal(own.status, 200);
  assert.equal(own.body.team.location, 'Main Gym');
  assert.equal(own.body.team.name, 'Basketball Boys', 'fields not sent stay as they were');

  const byAdmin = await t.api('PATCH', `/api/teams/${teamA.id}`, { location: null }, admin.token);
  assert.equal(byAdmin.status, 200);
  assert.equal(byAdmin.body.team.location, null);
});

// ---------------------------------------------------------------- competitions

test('competitions: create, list by sport, duplicates and permissions', async () => {
  const created = await t.api('POST', '/api/competitions', { name: 'Gauteng Schools Basketball League', sportId: sportId('Basketball'), season: '2026' }, coachA.token);
  assert.equal(created.status, 201);
  competition = created.body.competition;
  assert.equal(competition.sport.name, 'Basketball');

  const dupe = await t.api('POST', '/api/competitions', { name: 'GAUTENG schools basketball league' }, coachB.token);
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.error.code, 'COMPETITION_EXISTS');

  assert.equal((await t.api('POST', '/api/competitions', { name: 'Learner League' }, learner.token)).status, 403);

  const basketball = await t.api('GET', `/api/competitions?sportId=${sportId('Basketball')}`, undefined, learner.token);
  assert.equal(basketball.body.competitions.length, 1);
  const rugby = await t.api('GET', `/api/competitions?sportId=${sportId('Rugby')}`, undefined, learner.token);
  assert.equal(rugby.body.competitions.length, 0);
});

// ---------------------------------------------------------------- fixtures

const WHEN = '2026-11-06T18:00:00+02:00';
let fixture1, fixture2, playedId;

test('the home team\'s coach schedules a fixture; the time zone is respected', async () => {
  const res = await t.api('POST', '/api/fixtures', { homeTeamId: teamA.id, awayTeamId: teamB.id, matchDate: WHEN, venue: 'Main Gym', competitionId: competition.id, matchType: 'friendly' }, coachA.token);
  assert.equal(res.status, 201);
  fixture1 = res.body.fixture;
  assert.equal(fixture1.matchDate, '2026-11-06T16:00:00.000Z', '18:00 at +02:00 is 16:00 UTC');
  assert.equal(fixture1.status, 'scheduled');
  assert.equal(fixture1.matchType, 'friendly');
  assert.equal(fixture1.venue, 'Main Gym');
  assert.equal(fixture1.score, null);
  assert.equal(fixture1.sport.name, 'Basketball');
  assert.equal(fixture1.homeTeam.school.name, 'Jeppe High');
  assert.equal(fixture1.awayTeam.school.name, 'Greenwood');
  assert.equal(fixture1.competition.name, competition.name);
});

test('fixture rules: permissions, same team, sport mismatch, time zone, references', async () => {
  const body = { homeTeamId: teamA.id, awayTeamId: teamB.id, matchDate: WHEN };
  assert.equal((await t.api('POST', '/api/fixtures', body, coachB.token)).status, 403, 'away coach cannot schedule');
  assert.equal((await t.api('POST', '/api/fixtures', body, learner.token)).status, 403);

  const same = await t.api('POST', '/api/fixtures', { ...body, awayTeamId: teamA.id }, coachA.token);
  assert.equal(same.status, 400);
  assert.equal(same.body.error.code, 'SAME_TEAM');

  const mismatch = await t.api('POST', '/api/fixtures', { ...body, awayTeamId: teamFootball.id }, coachA.token);
  assert.equal(mismatch.body.error.code, 'SPORT_MISMATCH');

  const noZone = await t.api('POST', '/api/fixtures', { ...body, matchDate: '2026-11-06T18:00:00' }, coachA.token);
  assert.equal(noZone.status, 400);
  assert.ok(noZone.body.error.details.some((d) => d.field === 'matchDate'));
  assert.equal((await t.api('POST', '/api/fixtures', { ...body, matchDate: 'tomorrow' }, coachA.token)).status, 400);

  assert.equal((await t.api('POST', '/api/fixtures', { ...body, competitionId: 99999 }, coachA.token)).body.error.code, 'UNKNOWN_COMPETITION');
  assert.equal((await t.api('POST', '/api/fixtures', { ...body, matchType: 'derby' }, coachA.token)).status, 400);
  assert.equal((await t.api('POST', '/api/fixtures', { ...body, homeTeamId: 99999 }, coachA.token)).status, 404);
});

test('admins can schedule any fixture; match type defaults to league', async () => {
  const res = await t.api('POST', '/api/fixtures', { homeTeamId: teamA.id, awayTeamId: teamB.id, matchDate: '2026-11-13T10:30:00Z' }, admin.token);
  assert.equal(res.status, 201);
  assert.equal(res.body.fixture.matchType, 'league');
  fixture2 = res.body.fixture;

  // A played fixture with a final score, created directly in the database.
  const played = await t.pool.query(
    `INSERT INTO fixtures (home_team_id, away_team_id, match_date, location, status, match_type)
     VALUES ($1, $2, '2026-10-01T15:00:00Z', 'Greenwood Gym', 'finished', 'league') RETURNING id`,
    [teamB.id, teamA.id]
  );
  playedId = played.rows[0].id;
  await t.pool.query('INSERT INTO scores (fixture_id, home_team_score, away_team_score) VALUES ($1, 54, 68)', [playedId]);
});

test('fixture list: upcoming, past with score, mine, team, sport, competition, dates, status, paging', async () => {
  const ids = (res) => res.body.fixtures.map((f) => f.id);

  assert.deepEqual(ids(await t.api('GET', '/api/fixtures?when=upcoming', undefined, learner.token)), [fixture1.id, fixture2.id], 'soonest first');

  const past = await t.api('GET', '/api/fixtures?when=past', undefined, learner.token);
  assert.deepEqual(ids(past), [playedId]);
  assert.deepEqual(past.body.fixtures[0].score, { home: 54, away: 68 });

  assert.equal((await t.api('GET', '/api/fixtures?mine=true', undefined, coachA.token)).body.fixtures.length, 3);
  assert.equal((await t.api('GET', '/api/fixtures?mine=true', undefined, coachB.token)).body.fixtures.length, 3, 'away coaches see them too');
  assert.equal((await t.api('GET', '/api/fixtures?mine=true', undefined, coachC.token)).body.fixtures.length, 0);
  assert.equal((await t.api('GET', '/api/fixtures?mine=true', undefined, learner.token)).body.fixtures.length, 0);

  assert.equal((await t.api('GET', `/api/fixtures?teamId=${teamB.id}`, undefined, learner.token)).body.fixtures.length, 3);
  assert.equal((await t.api('GET', `/api/fixtures?teamId=${teamFootball.id}`, undefined, learner.token)).body.fixtures.length, 0);
  assert.equal((await t.api('GET', `/api/fixtures?sportId=${sportId('Basketball')}`, undefined, learner.token)).body.fixtures.length, 3);
  assert.equal((await t.api('GET', `/api/fixtures?sportId=${sportId('Rugby')}`, undefined, learner.token)).body.fixtures.length, 0);
  assert.deepEqual(ids(await t.api('GET', `/api/fixtures?competitionId=${competition.id}`, undefined, learner.token)), [fixture1.id]);
  assert.deepEqual(ids(await t.api('GET', '/api/fixtures?from=2026-11-10T00:00:00Z', undefined, learner.token)), [fixture2.id]);
  assert.deepEqual(ids(await t.api('GET', '/api/fixtures?to=2026-10-31T00:00:00Z', undefined, learner.token)), [playedId]);
  assert.equal((await t.api('GET', '/api/fixtures?order=desc', undefined, learner.token)).body.fixtures[0].id, fixture2.id);
  assert.deepEqual(ids(await t.api('GET', '/api/fixtures?status=finished', undefined, learner.token)), [playedId]);
  assert.equal((await t.api('GET', '/api/fixtures?status=nonsense', undefined, learner.token)).status, 400);
  assert.equal((await t.api('GET', '/api/fixtures?limit=2', undefined, learner.token)).body.fixtures.length, 2);
  assert.equal((await t.api('GET', '/api/fixtures')).status, 200, 'fixtures are public');
});

test('get one fixture, missing fixture', async () => {
  assert.equal((await t.api('GET', `/api/fixtures/${fixture1.id}`, undefined, learner.token)).body.fixture.id, fixture1.id);
  assert.equal((await t.api('GET', '/api/fixtures/99999', undefined, learner.token)).status, 404);
});

test('edit, cancel and lock a fixture', async () => {
  const edited = await t.api('PATCH', `/api/fixtures/${fixture1.id}`, { venue: 'Wildcats Gym', matchDate: '2026-11-07T10:30:00+02:00' }, coachA.token);
  assert.equal(edited.status, 200);
  assert.equal(edited.body.fixture.venue, 'Wildcats Gym');
  assert.equal(edited.body.fixture.matchDate, '2026-11-07T08:30:00.000Z');
  assert.equal(edited.body.fixture.matchType, 'friendly', 'fields not sent stay as they were');

  assert.equal((await t.api('PATCH', `/api/fixtures/${fixture1.id}`, { venue: 'x' }, coachB.token)).status, 403, 'away coach cannot edit');
  assert.equal((await t.api('PATCH', `/api/fixtures/${fixture1.id}`, { status: 'live' }, coachA.token)).status, 400, 'live comes from scoring');

  const cancelled = await t.api('PATCH', `/api/fixtures/${fixture1.id}`, { status: 'cancelled' }, coachA.token);
  assert.equal(cancelled.body.fixture.status, 'cancelled');
  const upcoming = await t.api('GET', '/api/fixtures?when=upcoming', undefined, learner.token);
  assert.deepEqual(upcoming.body.fixtures.map((f) => f.id), [fixture2.id], 'cancelled fixtures leave the upcoming list');

  const cleared = await t.api('PATCH', `/api/fixtures/${fixture1.id}`, { competitionId: null }, coachA.token);
  assert.equal(cleared.body.fixture.competition, null);

  const locked = await t.api('PATCH', `/api/fixtures/${playedId}`, { venue: 'x' }, admin.token);
  assert.equal(locked.status, 409);
  assert.equal(locked.body.error.code, 'FIXTURE_LOCKED');
  assert.equal((await t.api('PATCH', '/api/fixtures/99999', { venue: 'x' }, admin.token)).status, 404);
  assert.equal((await t.api('PATCH', `/api/fixtures/${fixture2.id}`, { competitionId: 99999 }, admin.token)).status, 400);
});

test('the database itself blocks bad fixtures', async () => {
  await assert.rejects(t.pool.query('INSERT INTO fixtures (home_team_id, away_team_id, match_date) VALUES ($1, $1, now())', [teamA.id]), { code: '23514' });
  await assert.rejects(t.pool.query("UPDATE fixtures SET status = 'banana' WHERE id = $1", [fixture2.id]), { code: '23514' });
  await assert.rejects(t.pool.query('INSERT INTO scores (fixture_id) VALUES ($1)', [playedId]), { code: '23505' });
});
