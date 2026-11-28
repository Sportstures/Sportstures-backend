const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { buildTable, summarise, DEFAULT_TIEBREAKERS } = require('../src/utils/standings');
const { startTestApp, signUpCoach } = require('./helpers/setup');

const game = (homeTeamId, homeScore, awayTeamId, awayScore) => ({ homeTeamId, homeScore, awayTeamId, awayScore });
const teams = (...names) => names.map((name, i) => ({ id: i + 1, name }));
const names = (table) => table.map((r) => r.team.name);

// ------------------------------------------------------------------ the maths

test('the standard order is points, difference, scored, then head-to-head', () => {
  assert.deepEqual(DEFAULT_TIEBREAKERS, ['difference', 'for', 'head_to_head']);
});

test('head-to-head separates teams that are level on points, difference and scored', () => {
  // A beat B 1-0, B beat C 1-0, D beat A 1-0. A and B finish level (3 points, 1 for, 1 against).
  const table = buildTable(teams('A', 'B', 'C', 'D'), [game(1, 1, 2, 0), game(2, 1, 3, 0), game(4, 1, 1, 0)]);
  assert.deepEqual(names(table), ['D', 'A', 'B', 'C']);
  assert.deepEqual(table.map((r) => r.position), [1, 2, 3, 4]);
  const a = table.find((r) => r.team.name === 'A');
  const b = table.find((r) => r.team.name === 'B');
  assert.equal(a.points, b.points);
  assert.equal(a.difference, b.difference);
  assert.equal(a.pointsFor, b.pointsFor);
  assert.equal(a.tiebreaker, 'head_to_head', 'the table says what separated them');
  assert.equal(table.find((r) => r.team.name === 'D').tiebreaker, 'difference');
  assert.equal(table.find((r) => r.team.name === 'C').tiebreaker, null, 'C is alone on points');
});

test('without head-to-head the same two teams share a position', () => {
  const table = buildTable(teams('A', 'B', 'C', 'D'), [game(1, 1, 2, 0), game(2, 1, 3, 0), game(4, 1, 1, 0)], { tiebreakers: ['difference', 'for'] });
  assert.deepEqual(table.map((r) => [r.position, r.team.name]), [[1, 'D'], [2, 'A'], [2, 'B'], [4, 'C']]);
});

test('a three-way cycle cannot be split, so the teams share a position', () => {
  // A beat B, B beat C, C beat A, all 1-0.
  const table = buildTable(teams('A', 'B', 'C'), [game(1, 1, 2, 0), game(2, 1, 3, 0), game(3, 1, 1, 0)]);
  assert.deepEqual(table.map((r) => [r.position, r.team.name, r.points]), [[1, 'A', 3], [1, 'B', 3], [1, 'C', 3]]);
});

test('a head-to-head that is itself level (one win each) leaves them sharing a position', () => {
  // A won 2-1 at home, B won 2-1 at home: identical on everything, including head-to-head.
  const table = buildTable(teams('A', 'B'), [game(1, 2, 2, 1), game(2, 2, 1, 1)]);
  assert.deepEqual(table.map((r) => [r.position, r.team.name, r.tiebreaker]), [[1, 'A', null], [1, 'B', null]]);
});

test('a competition can choose its own tiebreakers and their order', () => {
  // X beat Z 5-3. Y beat W 2-0. Both have 3 points and a +2 difference.
  const fixtures = [game(1, 5, 3, 3), game(2, 2, 4, 0)];
  const all = teams('X', 'Y', 'Z', 'W');
  assert.deepEqual(names(buildTable(all, fixtures)).slice(0, 2), ['X', 'Y'], 'standard: more scored wins');
  assert.deepEqual(names(buildTable(all, fixtures, { tiebreakers: ['against'] })).slice(0, 2), ['Y', 'X'], 'fewer conceded wins');
  assert.equal(buildTable(all, fixtures, { tiebreakers: ['against'] })[0].tiebreaker, 'against');
});

test('wins can be a tiebreaker, and it changes who is ahead', () => {
  // Alpha: one win, one loss (3 points, scored 1). Bravo: three draws (3 points, scored 3).
  const all = teams('Alpha', 'Bravo', 'C', 'D', 'E');
  const fixtures = [game(1, 1, 3, 0), game(4, 1, 1, 0), game(2, 1, 3, 1), game(2, 1, 4, 1), game(2, 1, 5, 1)];
  const order = (rules) => names(buildTable(all, fixtures, rules)).filter((n) => n === 'Alpha' || n === 'Bravo');
  assert.deepEqual(order(), ['Bravo', 'Alpha'], 'standard: Bravo scored more');
  assert.deepEqual(order({ tiebreakers: ['wins'] }), ['Alpha', 'Bravo'], 'wins first: Alpha won a game');
});

test('points per result can change: win 2, draw 1, loss 0', () => {
  const s = summarise([{ pointsFor: 3, pointsAgainst: 1 }, { pointsFor: 2, pointsAgainst: 2 }, { pointsFor: 0, pointsAgainst: 1 }], { win: 2, draw: 1, loss: 0 });
  assert.equal(s.points, 3);
  const table = buildTable(teams('A', 'B'), [game(1, 1, 2, 0)], { points: { win: 2 } });
  assert.equal(table[0].points, 2);
});

// ------------------------------------------------------------------ the API

let t; let coach; let other; let teamA; let teamB;

before(async () => {
  t = await startTestApp();
  coach = await signUpCoach(t, { email: 'a@x.co.za', school: 'Alpha High', team: { name: 'Alpha Netball', level: '1st_team', sport: 'Netball' } });
  other = await signUpCoach(t, { email: 'b@x.co.za', school: 'Bravo High', team: { name: 'Bravo Netball', level: '1st_team', sport: 'Netball' } });
  const mine = async (c) => (await t.api('GET', '/api/teams?mine=true', undefined, c.token)).body.teams[0];
  teamA = await mine(coach);
  teamB = await mine(other);
});
after(async () => { await t.stop(); });

const create = (body, token = coach.token) => t.api('POST', '/api/competitions', { name: `League ${Math.random()}`, ...body }, token);

test('a competition with no rules uses the standard ones', async () => {
  const res = await create({});
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.competition.rules, {
    pointsWin: 3, pointsDraw: 1, pointsLoss: 0, tiebreakers: ['difference', 'for', 'head_to_head'], custom: false,
  });
});

test('the organiser can set the points and the tiebreaker order', async () => {
  const res = await create({ pointsWin: 2, pointsDraw: 1, pointsLoss: 0, tiebreakers: ['head_to_head', 'against', 'difference'] });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.competition.rules, {
    pointsWin: 2, pointsDraw: 1, pointsLoss: 0, tiebreakers: ['head_to_head', 'against', 'difference'], custom: true,
  });
  const read = await t.api('GET', `/api/competitions/${res.body.competition.id}`);
  assert.deepEqual(read.body.competition.rules.tiebreakers, ['head_to_head', 'against', 'difference']);
});

test('rules are checked: known tiebreakers, no repeats, points 0 to 10', async () => {
  assert.equal((await create({ tiebreakers: ['luck'] })).status, 400);
  assert.equal((await create({ tiebreakers: ['for', 'for'] })).status, 400);
  assert.equal((await create({ tiebreakers: [] })).status, 400);
  assert.equal((await create({ pointsWin: 11 })).status, 400);
  assert.equal((await create({ pointsDraw: -1 })).status, 400);
});

test('the table uses the competition\'s points, and says how it is decided', async () => {
  const comp = (await create({ pointsWin: 2 })).body.competition;
  const fixture = (await t.api('POST', '/api/fixtures', { homeTeamId: teamA.id, awayTeamId: teamB.id, matchDate: '2026-09-01T15:00:00Z', competitionId: comp.id }, coach.token)).body.fixture;
  assert.equal((await t.api('PUT', `/api/fixtures/${fixture.id}/result`, { homeScore: 40, awayScore: 30 }, coach.token)).status, 200);

  const res = await t.api('GET', `/api/competitions/${comp.id}/standings`);
  assert.equal(res.body.standings[0].team.name, 'Alpha Netball');
  assert.equal(res.body.standings[0].points, 2, 'a win is worth 2 here');
  assert.equal(res.body.competition.rules.pointsWin, 2);
  assert.ok('tiebreaker' in res.body.standings[0]);
});

test('rules can be changed later, and null goes back to the standard order', async () => {
  const comp = (await create({ tiebreakers: ['wins'] })).body.competition;
  const changed = await t.api('PATCH', `/api/competitions/${comp.id}`, { pointsWin: 4, tiebreakers: ['against', 'for'] }, coach.token);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.competition.rules.pointsWin, 4);
  assert.deepEqual(changed.body.competition.rules.tiebreakers, ['against', 'for']);

  const reset = await t.api('PATCH', `/api/competitions/${comp.id}`, { tiebreakers: null }, coach.token);
  assert.deepEqual(reset.body.competition.rules.tiebreakers, ['difference', 'for', 'head_to_head']);
  assert.equal((await t.api('PATCH', `/api/competitions/${comp.id}`, { pointsWin: null }, coach.token)).status, 400, 'points cannot be blank');
});

test('only the competition\'s creator (or an admin) can change its rules', async () => {
  const comp = (await create({})).body.competition;
  const res = await t.api('PATCH', `/api/competitions/${comp.id}`, { pointsWin: 5 }, other.token);
  assert.equal(res.status, 403);
});

test('a competition card says whether the person asking may edit it', async () => {
  const comp = (await create({})).body.competition;
  assert.equal(comp.canEdit, true, 'its creator');
  const read = async (token) => (await t.api('GET', `/api/competitions/${comp.id}`, undefined, token)).body.competition.canEdit;
  assert.equal(await read(coach.token), true);
  assert.equal(await read(other.token), false);
  assert.equal(await read(undefined), false);
  const listed = (await t.api('GET', '/api/competitions', undefined, coach.token)).body.competitions;
  assert.equal(listed.find((c) => c.id === comp.id).canEdit, true);
});
