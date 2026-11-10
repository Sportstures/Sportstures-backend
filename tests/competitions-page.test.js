// GET /api/competitions (the learner Competitions screen), one competition, following, and editing.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, learnerPayload } = require('./helpers/setup');

let t;
let coaches; // by school key, each with { token, team }
let learner;
let league, cup, festival;

const card = (body, name) => body.competitions.find((c) => c.name === name);
const list = async (path, token) => {
  const res = await t.api('GET', path, undefined, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};
const day = (offsetDays) => new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString();

before(async () => {
  t = await startTestApp();
  coaches = {};
  for (const [key, school, province] of [['alpha', 'Alpha High', 'Gauteng'], ['bravo', 'Bravo High', 'Gauteng'], ['charlie', 'Charlie High', 'Western Cape']]) {
    const c = await signUpCoach(t, {
      email: `${key}@example.com`, school, schoolProvince: province,
      team: { name: `${school} Basketball`, level: '1st_team', sport: 'Basketball' },
    });
    c.team = (await t.api('GET', '/api/teams?mine=true', undefined, c.token)).body.teams[0];
    coaches[key] = c;
  }
  learner = await signUpLearner(t, learnerPayload({ email: 'learner@example.com', sport: null }));

  const create = async (coach, body) => {
    const res = await t.api('POST', '/api/competitions', { sportId: coaches.alpha.team.sport.id, ...body }, coaches[coach].token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.competition;
  };
  const play = async (competition, home, away, matchDate, score, matchType = 'league') => {
    const fixture = (await t.api('POST', '/api/fixtures', {
      homeTeamId: coaches[home].team.id, awayTeamId: coaches[away].team.id, matchDate, competitionId: competition.id, matchType,
    }, coaches[home].token)).body.fixture;
    if (score) {
      const res = await t.api('PUT', `/api/fixtures/${fixture.id}/result`, { homeScore: score[0], awayScore: score[1] }, coaches[home].token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
  };

  // Ongoing: one Gauteng derby played, the return match to come.
  league = await create('alpha', { name: 'Gauteng Basketball League' });
  await play(league, 'alpha', 'bravo', day(-10), [70, 60]);
  await play(league, 'bravo', 'alpha', day(10));

  // Upcoming: nothing scheduled yet, details set by the organiser.
  cup = await create('charlie', { name: 'Cape Basketball Cup', region: 'Western Cape', ageGroup: 'U/16', startDate: '2099-02-01', endDate: '2099-03-15', rounds: 4 });

  // Completed: Alpha tops the group, but Charlie wins the final.
  festival = await create('alpha', { name: 'Winter Basketball Festival' });
  await play(festival, 'alpha', 'charlie', day(-60), [80, 50]);
  await play(festival, 'charlie', 'alpha', day(-50), [66, 64], 'championship');
});
after(async () => { await t.stop(); });

test('every card carries status, region, age group, dates, teams, rounds and leader', async () => {
  const body = await list('/api/competitions');

  const l = card(body, 'Gauteng Basketball League');
  assert.equal(l.sport.name, 'Basketball');
  assert.deepEqual([l.status, l.region, l.ageGroup, l.teams, l.roundsPlayed, l.totalRounds], ['ongoing', 'Gauteng', 'Open', 2, 1, 2]);
  assert.match(l.startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(l.startDate < l.endDate, 'from the first match to the last');
  assert.deepEqual([l.leader.name, l.leader.points, l.leader.decidedBy, l.leader.team.id], ['Alpha High', 3, 'table', coaches.alpha.team.id]);
  assert.equal(l.following, false);

  const c = card(body, 'Cape Basketball Cup');
  assert.deepEqual([c.status, c.region, c.ageGroup, c.startDate, c.endDate, c.teams, c.roundsPlayed, c.totalRounds, c.leader],
    ['upcoming', 'Western Cape', 'U/16', '2099-02-01', '2099-03-15', 0, 0, 4, null]);

  const f = card(body, 'Winter Basketball Festival');
  assert.deepEqual([f.status, f.region, f.teams, f.roundsPlayed, f.totalRounds], ['completed', 'National', 2, 2, 2]);
  assert.deepEqual([f.leader.name, f.leader.decidedBy], ['Charlie High', 'final']);
});

test('tabs: status filter, counts for every tab, and ongoing → upcoming → completed order', async () => {
  const all = await list('/api/competitions');
  assert.deepEqual(all.counts, { all: 3, ongoing: 1, upcoming: 1, completed: 1 });
  assert.deepEqual(all.competitions.map((c) => c.status), ['ongoing', 'upcoming', 'completed']);

  const upcoming = await list('/api/competitions?status=upcoming');
  assert.deepEqual(upcoming.competitions.map((c) => c.name), ['Cape Basketball Cup']);
  assert.deepEqual(upcoming.counts, all.counts, 'counts ignore the status tab so every tab can show its number');

  assert.equal((await list('/api/competitions?region=National')).competitions.length, 1);
  assert.equal((await list('/api/competitions?q=cape')).competitions.length, 1);
  assert.equal((await list('/api/competitions?sportId=99999')).counts.all, 0);
  assert.equal((await list(`/api/competitions/${league.id}`)).competition.leader.name, 'Alpha High');
  assert.equal((await t.api('GET', '/api/competitions/99999')).status, 404);
});

test('following a competition turns alerts on and off', async () => {
  const on = await t.api('PUT', `/api/competitions/${cup.id}/follow`, undefined, learner.token);
  assert.deepEqual([on.status, on.body.following], [200, true]);
  assert.equal((await t.api('PUT', `/api/competitions/${cup.id}/follow`, undefined, learner.token)).status, 200, 'repeating is fine');

  const mine = await list('/api/competitions', learner.token);
  assert.equal(card(mine, 'Cape Basketball Cup').following, true);
  assert.equal(card(mine, 'Gauteng Basketball League').following, false);
  assert.equal(card(await list('/api/competitions'), 'Cape Basketball Cup').following, false, 'anonymous visitors follow nothing');
  assert.deepEqual((await list('/api/competitions?following=true', learner.token)).competitions.map((c) => c.name), ['Cape Basketball Cup']);
  assert.equal((await t.api('GET', '/api/competitions?following=true')).status, 401);

  const off = await t.api('DELETE', `/api/competitions/${cup.id}/follow`, undefined, learner.token);
  assert.equal(off.body.following, false);
  assert.equal((await list('/api/competitions?following=true', learner.token)).competitions.length, 0);

  assert.equal((await t.api('PUT', '/api/competitions/99999/follow', undefined, learner.token)).status, 404);
  assert.equal((await t.api('PUT', `/api/competitions/${cup.id}/follow`)).status, 401);
});

test('the creating coach can edit details; null goes back to the worked-out value', async () => {
  assert.equal((await t.api('PATCH', `/api/competitions/${league.id}`, { rounds: 5 }, coaches.bravo.token)).status, 403);
  assert.equal((await t.api('PATCH', `/api/competitions/${league.id}`, { rounds: 5 }, learner.token)).status, 403);

  const edited = await t.api('PATCH', `/api/competitions/${league.id}`, { rounds: 6, region: 'National', ageGroup: 'U/19' }, coaches.alpha.token);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual([edited.body.competition.totalRounds, edited.body.competition.region, edited.body.competition.ageGroup], [6, 'National', 'U/19']);

  const cleared = await t.api('PATCH', `/api/competitions/${league.id}`, { rounds: null, region: null, ageGroup: null }, coaches.alpha.token);
  assert.deepEqual([cleared.body.competition.totalRounds, cleared.body.competition.region, cleared.body.competition.ageGroup], [2, 'Gauteng', 'Open']);

  const backwards = await t.api('PATCH', `/api/competitions/${cup.id}`, { endDate: '2099-01-01' }, coaches.charlie.token);
  assert.deepEqual([backwards.status, backwards.body.error.code], [400, 'INVALID_DATES']);
});

test('bad input is a 400 with details', async () => {
  const res = await t.api('GET', '/api/competitions?status=finished&region=Mars&following=maybe');
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.error.details.map((d) => d.field).sort(), ['following', 'region', 'status']);

  const bad = await t.api('POST', '/api/competitions',
    { name: 'Bad Dates', startDate: '2099-05-01', endDate: '2099-04-01', ageGroup: 'U15', rounds: 0 }, coaches.alpha.token);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.error.details.map((d) => d.field).sort(), ['ageGroup', 'endDate', 'rounds']);
});
