const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach } = require('./helpers/setup');

let t;
let teams; // by school name
let todayLocal; // today's South African date when the test ran
let todaysFixtureDay; // the South African day of the match played a minute ago

const anon = async (path) => {
  const res = await t.api('GET', path);
  assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`);
  return res.body;
};
const saDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(date);
const allResults = (body) => body.days.flatMap((d) => d.results);

before(async () => {
  t = await startTestApp();

  // Five schools: three basketball teams (two in Gauteng, one in the Western Cape) and two girls' netball teams.
  const coaches = {};
  const coach = async (school, province, sport, level = '1st_team') => {
    const c = await signUpCoach(t, {
      email: `${school.split(' ')[0].toLowerCase()}@example.com`,
      school,
      schoolProvince: province,
      team: { name: `${school} ${sport}`, level, sport },
    });
    coaches[school] = c;
  };
  await coach('Alpha High', 'Gauteng', 'Basketball');
  await coach('Bravo High', 'Western Cape', 'Basketball');
  await coach('Charlie High', 'Gauteng', 'Basketball');
  await coach('Delta High', 'Gauteng', 'Netball', 'u16');
  await coach('Echo High', 'Western Cape', 'Netball', 'u16');

  teams = {};
  for (const [school, c] of Object.entries(coaches)) {
    const team = (await t.api('GET', '/api/teams?mine=true', undefined, c.token)).body.teams[0];
    teams[school] = { ...team, token: c.token };
  }
  for (const school of ['Delta High', 'Echo High']) {
    await t.api('PATCH', `/api/teams/${teams[school].id}`, { genderCategory: 'girls' }, teams[school].token);
  }

  const play = async (home, away, matchDate, homeScore, awayScore, venue) => {
    const fixture = (await t.api('POST', '/api/fixtures', {
      homeTeamId: teams[home].id, awayTeamId: teams[away].id, matchDate, venue,
    }, teams[home].token)).body.fixture;
    if (homeScore !== undefined) {
      const res = await t.api('PUT', `/api/fixtures/${fixture.id}/result`, { homeScore, awayScore }, teams[home].token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    return fixture;
  };

  await play('Delta High', 'Echo High', '2026-08-20T10:00:00Z', 10, 20, 'Echo Netball Courts'); // away win
  await play('Alpha High', 'Bravo High', '2026-09-01T15:00:00Z', 3, 1, 'Alpha Gym'); // home win
  // 22:30 UTC is 00:30 on 2 September in South Africa.
  await play('Bravo High', 'Alpha High', '2026-09-01T22:30:00Z', 2, 2, 'Bravo Gym'); // draw
  const minuteAgo = new Date(Date.now() - 60 * 1000);
  await play('Alpha High', 'Charlie High', minuteAgo.toISOString(), 1, 0, 'Alpha Gym'); // home win
  await play('Charlie High', 'Bravo High', '2030-01-01T10:00:00Z'); // scheduled: not a result

  todayLocal = saDay(new Date());
  todaysFixtureDay = saDay(minuteAgo);
});
after(async () => { await t.stop(); });

test('results are grouped by South African day, newest first, with labels', async () => {
  const body = await anon('/api/results?limit=31');

  assert.equal(body.today, todayLocal);
  assert.deepEqual(body.days.map((d) => d.date), [todaysFixtureDay, '2026-09-02', '2026-09-01', '2026-08-20']);
  assert.equal(body.days[0].isToday, todaysFixtureDay === todayLocal);
  assert.equal(body.days[1].isToday, false);
  assert.ok(body.days.every((d) => d.count === d.results.length));
  assert.equal(allResults(body).length, 4, 'the scheduled fixture is not a result');

  const draw = body.days[1].results[0];
  assert.equal(draw.homeTeam.school.name, 'Bravo High');
  assert.deepEqual(draw.score, { home: 2, away: 2 });
  assert.equal(draw.winner, 'draw');
  assert.equal(draw.venue, 'Bravo Gym');
  assert.equal(draw.category, 'Basketball 1st Team');
  assert.equal(body.days[3].results[0].category, 'Girls Netball U/16');
});

test('the summary covers every matching result, not just the page', async () => {
  const expected = { matchesPlayed: 4, homeWins: 2, awayWins: 1, draws: 1, totalScored: 39 };
  const first = await anon('/api/results?limit=2');
  const second = await anon('/api/results?limit=2&offset=2');

  assert.deepEqual(first.summary, expected);
  assert.deepEqual(second.summary, expected);
  assert.deepEqual([first.days.length, first.totalDays, first.hasMore], [2, 4, true]);
  assert.deepEqual([second.days.length, second.hasMore], [2, false]);
  assert.deepEqual(second.days.map((d) => d.date), ['2026-09-01', '2026-08-20']);
  assert.equal((await anon('/api/results')).limit, 3, 'three days per page by default');
});

test('filters: sport, province, search and dates', async () => {
  const netball = await anon(`/api/results?sportId=${teams['Delta High'].sport.id}`);
  assert.deepEqual(allResults(netball).map((r) => r.homeTeam.school.name), ['Delta High']);
  assert.equal(netball.summary.matchesPlayed, 1);

  // A match counts for a province when either school is there.
  const westernCape = await anon('/api/results?province=Western%20Cape&limit=31');
  assert.equal(westernCape.summary.matchesPlayed, 3);

  assert.equal(allResults(await anon('/api/results?q=echo%20netball')).length, 1, 'venue');
  assert.equal(allResults(await anon('/api/results?q=CHARLIE')).length, 1, 'school, any case');
  assert.equal(allResults(await anon('/api/results?q=100%25')).length, 0, '% is plain text');

  // from/to are South African days: only the 00:30 match is on 2 September.
  const second = await anon('/api/results?from=2026-09-02&to=2026-09-02');
  assert.deepEqual(allResults(second).map((r) => r.homeTeam.school.name), ['Bravo High']);
});

test('period tabs follow the South African calendar', async () => {
  const today = await anon('/api/results?period=today');
  assert.ok(today.days.every((d) => d.date === todayLocal && d.isToday));
  assert.equal(allResults(today).length, todaysFixtureDay === todayLocal ? 1 : 0);

  const month = await anon('/api/results?period=month&limit=31');
  assert.ok(month.days.every((d) => d.date.slice(0, 7) === todayLocal.slice(0, 7)));
  assert.ok(month.days.every((d) => !d.date.startsWith('2026-08')));

  const yesterday = await anon('/api/results?period=yesterday');
  assert.ok(yesterday.days.every((d) => d.date !== todayLocal));
});

test('filters lists the sports and provinces that have results', async () => {
  const body = await anon('/api/results/filters');
  assert.deepEqual(body.sports.map((s) => s.name), ['Basketball', 'Netball']);
  assert.deepEqual(body.provinces, ['Gauteng', 'Western Cape']);
  assert.deepEqual(body.periods, ['all', 'today', 'yesterday', 'week', 'month']);
});

test('standings rank schools by points, then difference', async () => {
  const body = await anon('/api/results/standings');
  const table = body.standings.map((r) => [r.position, r.school.name, r.played, r.won, r.drawn, r.lost, r.points]);
  assert.deepEqual(table, [
    [1, 'Alpha High', 3, 2, 1, 0, 7],
    [2, 'Echo High', 1, 1, 0, 0, 3],
    [3, 'Bravo High', 2, 0, 1, 1, 1],
    [4, 'Charlie High', 1, 0, 0, 1, 0], // lost by 1
    [5, 'Delta High', 1, 0, 0, 1, 0], // lost by 10
  ]);
  assert.deepEqual(body.standings[0].form, ['W', 'D', 'W']);
  assert.equal(body.standings[0].school.province, 'Gauteng');

  const top2 = await anon('/api/results/standings?limit=2');
  assert.deepEqual([top2.standings.length, top2.totalSchools], [2, 5]);

  const basketball = await anon(`/api/results/standings?sportId=${teams['Alpha High'].sport.id}`);
  assert.equal(basketball.sport.name, 'Basketball');
  assert.deepEqual(basketball.standings.map((r) => r.school.name), ['Alpha High', 'Bravo High', 'Charlie High']);
});

test('a province table numbers its own schools, counting all their matches', async () => {
  const body = await anon('/api/results/standings?province=Western%20Cape');
  assert.equal(body.province, 'Western Cape');
  assert.deepEqual(body.standings.map((r) => [r.position, r.school.name, r.played]), [
    [1, 'Echo High', 1],
    [2, 'Bravo High', 2], // both matches were against Alpha High in Gauteng
  ]);
});

test('bad filters are a 400 with details', async () => {
  const res = await t.api('GET', '/api/results?period=decade&province=Narnia&from=2026-13-01&limit=99');
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.error.details.map((d) => d.field).sort(), ['from', 'limit', 'period', 'province']);
  assert.equal((await t.api('GET', '/api/results/standings?limit=0')).status, 400);
});
