// The ranking points maths (src/utils/rankings.js). No database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BREAKDOWN, ageGroupOf, scoreTeams, addRecords, rank, withTrend } = require('../src/utils/rankings');

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const match = (id, homeTeamId, awayTeamId, homeScore, awayScore) => ({ id, homeTeamId, awayTeamId, homeScore, awayScore });

test('the breakdown weights add up to 100%', () => {
  assert.deepEqual(BREAKDOWN.map((b) => [b.label, b.weight]), [
    ['Match Wins', 0.4], ['Strength of Opposition', 0.25], ['Goals Scored', 0.2], ['Consistency', 0.1], ['Participation', 0.05],
  ]);
  close(BREAKDOWN.reduce((sum, b) => sum + b.weight, 0), 1);
});

test('team levels map onto the screen\'s age groups', () => {
  assert.deepEqual(['u14', 'U/13', 'u15', 'U16', 'u18', 'u19', 'u21', '1st_team', '2nd_team', 'Varsity', null]
    .map(ageGroupOf), ['U/14', 'U/14', 'U/16', 'U/16', 'U/19', 'U/19', 'Open', 'Open', 'Open', 'Open', 'Open']);
});

test('each match is scored on result, opposition, share of the score, consistency and turning up', () => {
  // A beats B 3-1, then B draws C 2-2. Season records: A 1/1, B 0.5/2, C 0.5/1.
  const { teams, byMatch } = scoreTeams([match(1, 'A', 'B', 3, 1), match(2, 'B', 'C', 2, 2)]);

  // A: win 40 + 25 x 0.25 + 20 x 3/4 + no previous match + 5.
  assert.deepEqual(byMatch.get(1).get('A').parts, { wins: 40, opposition: 6.25, scoring: 15, consistency: 0, participation: 5 });
  close(teams.get('A').points, 66.25);
  // B: lost to an unbeaten side (0 + 25 + 5 + 0 + 5), then drew (20 + 12.5 + 10 + 0, the loss broke the run, + 5).
  close(teams.get('B').points, 35 + 47.5);
  assert.deepEqual([teams.get('B').played, teams.get('B').won, teams.get('B').drawn, teams.get('B').lost], [2, 0, 1, 1]);
  assert.equal(byMatch.get(2).get('B').result, 0);
  close(teams.get('C').points, 20 + 6.25 + 10 + 0 + 5);
});

test('consistency rewards back-to-back unbeaten matches', () => {
  const { byMatch } = scoreTeams([match(1, 'X', 'Y', 1, 0), match(2, 'X', 'Y', 0, 0), match(3, 'Y', 'X', 2, 0), match(4, 'X', 'Y', 1, 0)]);
  assert.deepEqual([1, 2, 3, 4].map((id) => byMatch.get(id).get('X').parts.consistency), [0, 10, 0, 0]);
});

test('records add up, positions are shared on equal rounded points, and trends compare positions', () => {
  const r = (points) => ({ points, played: 1, won: 1, drawn: 0, lost: 0, breakdown: { wins: points, opposition: 0, scoring: 0, consistency: 0, participation: 0 } });
  assert.equal(addRecords([r(10), r(5)]).points, 15);

  const ranked = rank([
    { key: 1, name: 'Bravo', ...r(10.4) },
    { key: 2, name: 'Alpha', ...r(9.6) },
    { key: 3, name: 'Charlie', ...r(30) },
  ]);
  assert.deepEqual(ranked.map((x) => [x.position, x.name, x.points]), [[1, 'Charlie', 30], [2, 'Alpha', 10], [2, 'Bravo', 10]]);

  const trended = withTrend(ranked, [{ key: 2, position: 1 }, { key: 3, position: 3 }]);
  assert.deepEqual(trended.map((x) => [x.name, x.previousPosition, x.trend]),
    [['Charlie', 3, 2], ['Alpha', 1, -1], ['Bravo', null, null]]);
});
