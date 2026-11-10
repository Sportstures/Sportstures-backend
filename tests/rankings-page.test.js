// GET /api/rankings, /overview and /filters: the learner Rankings screen.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, learnerPayload } = require('./helpers/setup');

let t;
let teams; // by key
let players;
let season;
let trendKnown; // false in the first week of January, when last week was a different season

const anon = async (path) => {
  const res = await t.api('GET', path);
  assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`);
  return res.body;
};
const table = (body) => body.rankings.map((r) => [r.position, r.name, r.points]);

before(async () => {
  t = await startTestApp();
  season = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric' }).format(new Date()));

  // Alpha High (Gauteng) has a basketball and a netball team; Charlie High (Gauteng) plays U/14;
  // Bravo High and Delta High are in the Western Cape.
  const specs = {
    alphaB: ['Alpha High', 'Gauteng', 'Basketball', '1st_team'],
    alphaN: ['Alpha High', 'Gauteng', 'Netball', 'u16'],
    bravo: ['Bravo High', 'Western Cape', 'Basketball', '1st_team'],
    charlie: ['Charlie High', 'Gauteng', 'Basketball', 'u14'],
    delta: ['Delta High', 'Western Cape', 'Netball', 'u16'],
  };
  teams = {};
  for (const [key, [school, province, sport, level]] of Object.entries(specs)) {
    const coach = await signUpCoach(t, {
      email: `${key}@example.com`, school, schoolProvince: province, team: { name: `${school} ${sport}`, level, sport },
    });
    const team = (await t.api('GET', '/api/teams?mine=true', undefined, coach.token)).body.teams[0];
    teams[key] = { ...team, token: coach.token };
  }

  // Two Alpha basketball players and one from Bravo.
  players = {};
  for (const [key, first, team, jersey] of [['p1', 'Pat', 'alphaB', 4], ['p2', 'Quinn', 'alphaB', 9], ['p3', 'Rae', 'bravo', 5]]) {
    players[key] = await signUpLearner(t, learnerPayload({
      email: `${key}@example.com`, firstName: first, lastName: 'Player',
      school: { name: teams[team].school.name, grade: 10, className: '10A' }, sport: null,
    }));
    const added = await t.api('POST', `/api/teams/${teams[team].id}/roster`, { userId: players[key].user.id, jerseyNumber: jersey }, teams[team].token);
    assert.equal(added.status, 201, JSON.stringify(added.body));
  }

  const play = async (home, away, matchDate, homeScore, awayScore, lineups = {}) => {
    const fixture = (await t.api('POST', '/api/fixtures', {
      homeTeamId: teams[home].id, awayTeamId: teams[away].id, matchDate,
    }, teams[home].token)).body.fixture;
    for (const [side, lineup] of Object.entries(lineups)) {
      const res = await t.api('PUT', `/api/fixtures/${fixture.id}/lineups/${teams[side].id}`, lineup, teams[side].token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    const res = await t.api('PUT', `/api/fixtures/${fixture.id}/result`, { homeScore, awayScore }, teams[home].token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
  };
  const ago = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const id = (key) => ({ userId: players[key].user.id });

  // Midnight on 1 January in South Africa: the first moment of the season, and over a week ago
  // unless the tests run in the first week of January.
  const newYear = new Date(Date.UTC(season - 1, 11, 31, 22, 0, 0));
  trendKnown = Date.now() - newYear.getTime() > 8 * 24 * 60 * 60 * 1000;

  await play('bravo', 'alphaB', newYear.toISOString(), 50, 40); // last week's only result
  await play('delta', 'alphaN', ago(4), 20, 10);
  await play('alphaB', 'charlie', ago(3), 60, 30, { alphaB: { starters: [id('p1')], bench: [id('p2')] } });
  await play('alphaB', 'bravo', ago(2), 70, 50, {
    alphaB: { starters: [id('p1')], bench: [id('p2')] },
    bravo: { starters: [id('p3')] },
  });
  await play('alphaN', 'delta', ago(1), 30, 30);
});
after(async () => { await t.stop(); });

// Expected points, worked out by hand from the rules in src/utils/rankings.js:
//   Alpha basketball 26.39 + 58.33 + 79.17 = 163.89    Delta 64.58 + 51.25 = 115.83
//   Bravo 72.78 + 30 = 102.78    Alpha netball 30.42 + 53.75 = 84.17    Charlie 28.33

test('schools add up their teams\' points, newest season by default', async () => {
  const body = await anon('/api/rankings');
  assert.equal(body.type, 'schools');
  assert.equal(body.season, season);
  assert.ok(body.updatedAt);
  assert.deepEqual(table(body), [[1, 'Alpha High', 248], [2, 'Delta High', 116], [3, 'Bravo High', 103], [4, 'Charlie High', 28]]);

  const alpha = body.rankings[0];
  assert.equal(alpha.detail, '2 sports played');
  assert.equal(alpha.province, 'Gauteng');
  assert.deepEqual([alpha.played, alpha.won, alpha.drawn, alpha.lost, alpha.sportsPlayed, alpha.teamsRanked], [5, 2, 1, 2, 2, 2]);
  assert.deepEqual(Object.keys(alpha.breakdown), ['wins', 'opposition', 'scoring', 'consistency', 'participation']);
  assert.equal(alpha.breakdown.participation, 25);
});

test('trend compares with the ranking a week ago; new entries have none', async (ctx) => {
  if (!trendKnown) return ctx.skip('last week was in another season');
  const schools = await anon('/api/rankings');
  assert.deepEqual(schools.rankings.map((r) => [r.name, r.previousPosition, r.trend]), [
    ['Alpha High', 2, 1], ['Delta High', null, null], ['Bravo High', 1, -2], ['Charlie High', null, null],
  ]);
  const regions = await anon('/api/rankings?type=regions');
  assert.deepEqual(regions.rankings.map((r) => [r.name, r.trend]), [['Gauteng', 1], ['Western Cape', -1]]);
});

test('teams are listed under their school with a category label, paged', async () => {
  const body = await anon('/api/rankings?type=teams&limit=2');
  assert.deepEqual(table(body), [[1, 'Alpha High', 164], [2, 'Delta High', 116]]);
  assert.equal(body.rankings[0].detail, 'Basketball 1st Team');
  assert.equal(body.rankings[0].team.ageGroup, 'Open');
  assert.equal(body.rankings[1].detail, 'Netball U/16');
  assert.deepEqual([body.total, body.limit, body.offset, body.hasMore], [5, 2, 0, true]);

  const rest = await anon('/api/rankings?type=teams&limit=2&offset=4');
  assert.deepEqual([table(rest), rest.hasMore], [[[5, 'Charlie High', 28]], false]);
  assert.equal((await anon('/api/rankings?type=teams')).limit, 10, 'top 10 by default');
});

test('athletes earn their team\'s match points from the lineup, bench players half', async () => {
  const body = await anon('/api/rankings?type=athletes');
  assert.deepEqual(table(body), [[1, 'Pat Player', 138], [2, 'Quinn Player', 69], [3, 'Rae Player', 30]]);
  assert.equal(body.rankings[0].detail, 'Alpha High · Basketball');
  assert.equal(body.rankings[0].athlete.id, players.p1.user.id);
  assert.deepEqual([body.rankings[0].played, body.rankings[0].won], [2, 2]);
});

test('regions average their schools', async () => {
  const body = await anon('/api/rankings?type=regions');
  assert.deepEqual(body.rankings.map((r) => [r.position, r.name, r.detail, r.points]), [
    [1, 'Gauteng', '2 schools', 138], // (248.06 + 28.33) / 2
    [2, 'Western Cape', '2 schools', 109], // (115.83 + 102.78) / 2
  ]);
});

test('sport and age group pick which matches count; province picks who is listed', async () => {
  const netball = await anon(`/api/rankings?sportId=${teams.delta.sport.id}`);
  assert.deepEqual(table(netball), [[1, 'Delta High', 116], [2, 'Alpha High', 84]]);
  assert.equal(netball.filters.sport.name, 'Netball');

  const u14 = await anon('/api/rankings?type=teams&ageGroup=U%2F14');
  assert.deepEqual(table(u14), [[1, 'Charlie High', 28]]);

  const westernCape = await anon('/api/rankings?province=Western%20Cape');
  assert.deepEqual(table(westernCape), [[1, 'Delta High', 116], [2, 'Bravo High', 103]]);

  const empty = await anon(`/api/rankings?season=${season - 5}`);
  assert.deepEqual([empty.total, empty.rankings, empty.updatedAt], [0, [], null]);
});

test('overview: breakdown, top sports, risers and region leaders', async () => {
  const body = await anon('/api/rankings/overview');
  assert.deepEqual(body.breakdown.map((b) => b.weight), [0.4, 0.25, 0.2, 0.1, 0.05]);
  assert.deepEqual(body.topSports.map((s) => [s.sport.name, s.label, s.school.name, s.points]), [
    ['Basketball', 'Basketball 1st Team', 'Alpha High', 164],
    ['Netball', 'Netball U/16', 'Delta High', 116],
  ]);
  assert.deepEqual(body.regionLeaders.map((r) => [r.province, r.leader.name]), [['Gauteng', 'Alpha High'], ['Western Cape', 'Delta High']]);
  if (trendKnown) assert.deepEqual(body.topRisers.map((r) => [r.name, r.trend]), [['Alpha High', 1]]);
});

test('filters lists what the season has', async () => {
  const body = await anon('/api/rankings/filters');
  assert.deepEqual(body.seasons, [season]);
  assert.deepEqual(body.types, ['schools', 'teams', 'athletes', 'regions']);
  assert.deepEqual(body.sports.map((s) => s.name), ['Basketball', 'Netball']);
  assert.deepEqual(body.ageGroups, ['U/14', 'U/16', 'U/19', 'Open']);
  assert.deepEqual(body.provinces, ['Gauteng', 'Western Cape']);
});

test('bad filters are a 400 with details', async () => {
  const res = await t.api('GET', '/api/rankings?type=players&ageGroup=U15&province=Narnia&limit=500&season=99');
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.error.details.map((d) => d.field).sort(), ['ageGroup', 'limit', 'province', 'season', 'type']);
});
