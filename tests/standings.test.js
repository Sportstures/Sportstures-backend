const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarise, buildTable, teamRecord } = require('../src/utils/standings');

const game = (homeTeamId, homeScore, awayTeamId, awayScore) => ({ homeTeamId, homeScore, awayTeamId, awayScore });

test('summarise counts wins, draws, losses, points and form', () => {
  const s = summarise([
    { pointsFor: 70, pointsAgainst: 60 }, // W
    { pointsFor: 50, pointsAgainst: 50 }, // D
    { pointsFor: 40, pointsAgainst: 55 }, // L
  ]);
  assert.equal(s.played, 3);
  assert.equal(s.won, 1);
  assert.equal(s.drawn, 1);
  assert.equal(s.lost, 1);
  assert.equal(s.points, 4, 'win 3 + draw 1');
  assert.equal(s.pointsFor, 160);
  assert.equal(s.pointsAgainst, 165);
  assert.equal(s.difference, -5);
  assert.equal(s.winRate, 33.3);
  assert.equal(s.averageScored, 53.3);
  assert.equal(s.averageConceded, 55);
  assert.deepEqual(s.form, ['W', 'D', 'L']);
});

test('summarise of no matches has zeros and null rates (no divide by zero)', () => {
  const s = summarise([]);
  assert.equal(s.played, 0);
  assert.equal(s.points, 0);
  assert.equal(s.winRate, null);
  assert.equal(s.averageScored, null);
  assert.deepEqual(s.form, []);
});

test('form keeps only the last five results, oldest first', () => {
  const results = ['W', 'L', 'W', 'W', 'D', 'L', 'W'].map((r) => (
    r === 'W' ? { pointsFor: 2, pointsAgainst: 1 } : r === 'L' ? { pointsFor: 1, pointsAgainst: 2 } : { pointsFor: 1, pointsAgainst: 1 }));
  assert.deepEqual(summarise(results).form, ['W', 'W', 'D', 'L', 'W']);
});

test('buildTable orders by points, then difference, then points for, then name', () => {
  const teams = [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Bravo' }, { id: 3, name: 'Charlie' }];
  const table = buildTable(teams, [
    game(1, 70, 2, 60), // Alpha beats Bravo
    game(2, 55, 3, 55), // Bravo draws Charlie
    game(1, 40, 3, 50), // Charlie beats Alpha
  ]);
  assert.deepEqual(table.map((r) => [r.position, r.team.name, r.points]), [
    [1, 'Charlie', 4],
    [2, 'Alpha', 3],
    [3, 'Bravo', 1],
  ]);
  assert.equal(table[0].difference, 10);
  assert.equal(table[1].difference, 0);
  assert.equal(table[2].difference, -10);
});

test('goal difference separates teams that are level on points', () => {
  const teams = [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Bravo' }, { id: 3, name: 'Charlie' }];
  // Alpha and Bravo each win once (3 points). Bravo wins by more.
  const table = buildTable(teams, [game(1, 2, 3, 1), game(2, 9, 3, 0)]);
  assert.deepEqual(table.map((r) => r.team.name), ['Bravo', 'Alpha', 'Charlie']);
  assert.deepEqual(table.map((r) => r.position), [1, 2, 3]);
});

test('teams level on every measure share a position and sort by name', () => {
  const teams = [{ id: 1, name: 'Zulu' }, { id: 2, name: 'Alpha' }];
  const table = buildTable(teams, []);
  assert.deepEqual(table.map((r) => [r.position, r.team.name]), [[1, 'Alpha'], [1, 'Zulu']]);
});

test('a team with no matches still appears with zeros', () => {
  const table = buildTable([{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 9, name: 'Idle' }], [game(1, 1, 2, 0)]);
  const idle = table.find((r) => r.team.id === 9);
  assert.equal(idle.played, 0);
  assert.equal(idle.points, 0);
  // A has 3 points; the idle team (0 points, difference 0) ranks above B (0 points, difference -1).
  assert.deepEqual(table.map((r) => [r.position, r.team.name]), [[1, 'A'], [2, 'Idle'], [3, 'B']]);
});

test('teamRecord looks at one team from either side of the fixture', () => {
  const fixtures = [game(1, 10, 2, 5), game(3, 1, 1, 4), game(2, 3, 3, 3)];
  const r = teamRecord(1, fixtures);
  assert.equal(r.played, 2);
  assert.equal(r.won, 2);
  assert.equal(r.pointsFor, 14);
  assert.equal(r.pointsAgainst, 6);
  assert.deepEqual(r.form, ['W', 'W']);
  assert.equal(teamRecord(99, fixtures).played, 0);
});
