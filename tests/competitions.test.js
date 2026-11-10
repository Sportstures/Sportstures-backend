// Competition cards (src/utils/competitions.js): status, region, age group, dates, rounds, leader. No database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describe, compare } = require('../src/utils/competitions');

const TODAY = '2026-11-10';
const school = (id, name, province) => ({ id, name, province, town: null });
const team = (id, level, s) => ({ id, name: `Team ${id}`, level, genderCategory: null, sport: null, school: s, ageGroup: level === 'u16' ? 'U/16' : 'Open' });
const teams = new Map([
  [1, team(1, 'u16', school(1, 'Alpha High', 'Gauteng'))],
  [2, team(2, 'u16', school(2, 'Bravo High', 'Gauteng'))],
  [3, team(3, '1st_team', school(3, 'Charlie High', 'Western Cape'))],
]);
const comp = (extra = {}) => ({ province: null, age_group: null, start_date: null, end_date: null, total_rounds: null, ...extra });
let nextId = 1;
const fx = (home, away, day, homeScore = null, awayScore = null, extra = {}) => ({
  id: nextId++, homeTeamId: home, awayTeamId: away, day, homeScore, awayScore,
  status: homeScore === null ? 'scheduled' : 'finished', matchType: 'league', ...extra,
});

test('with nothing scheduled a competition is upcoming and empty', () => {
  assert.deepEqual(describe(comp(), [], teams, TODAY), {
    status: 'upcoming', region: null, ageGroup: null, startDate: null, endDate: null,
    teams: 0, roundsPlayed: 0, totalRounds: 0, leader: null,
  });
});

test('region and age group come from the teams when not set', () => {
  const gauteng = describe(comp(), [fx(1, 2, '2026-12-01')], teams, TODAY);
  assert.deepEqual([gauteng.status, gauteng.region, gauteng.ageGroup, gauteng.startDate, gauteng.teams], ['upcoming', 'Gauteng', 'U/16', '2026-12-01', 2]);

  const mixed = describe(comp(), [fx(1, 3, '2026-12-01')], teams, TODAY);
  assert.deepEqual([mixed.region, mixed.ageGroup], ['National', null]);

  const set = describe(comp({ province: 'Limpopo', age_group: 'U/19', start_date: '2027-01-14', end_date: '2027-01-16' }), [], teams, TODAY);
  assert.deepEqual([set.region, set.ageGroup, set.startDate, set.endDate, set.status], ['Limpopo', 'U/19', '2027-01-14', '2027-01-16', 'upcoming']);
});

test('ongoing: the round follows the share of fixtures played, and the table leads', () => {
  // A round robin of three teams twice over: four rounds, 6 fixtures; 4 played.
  const fixtures = [
    fx(1, 2, '2026-10-01', 2, 0), fx(2, 3, '2026-10-08', 1, 1), fx(3, 1, '2026-10-15', 0, 3), fx(1, 3, '2026-10-22', 0, 1),
    fx(2, 1, '2026-11-20'), fx(3, 2, '2026-11-27'),
  ];
  const c = describe(comp(), fixtures, teams, TODAY);
  assert.deepEqual([c.status, c.startDate, c.endDate, c.teams, c.roundsPlayed, c.totalRounds], ['ongoing', '2026-10-01', '2026-11-27', 3, 3, 4]);
  assert.deepEqual([c.leader.name, c.leader.points, c.leader.decidedBy], ['Alpha High', 6, 'table']);

  // One match left: still not the last round.
  const nearlyDone = describe(comp({ total_rounds: 2 }), [fx(1, 2, '2026-10-01', 1, 0), fx(1, 3, '2026-10-02', 1, 0), fx(2, 3, '2026-12-01')], teams, TODAY);
  assert.deepEqual([nearlyDone.roundsPlayed, nearlyDone.totalRounds], [1, 2]);
});

test('completed: the winner of a final is champion, ahead of the table', () => {
  const fixtures = [
    fx(1, 2, '2026-06-01', 3, 0), fx(1, 3, '2026-06-02', 3, 0),
    fx(3, 1, '2026-06-10', 2, 1, { matchType: 'championship' }),
  ];
  const c = describe(comp(), fixtures, teams, TODAY);
  assert.deepEqual([c.status, c.roundsPlayed, c.totalRounds], ['completed', 3, 3]);
  assert.deepEqual([c.leader.name, c.leader.decidedBy, c.leader.points], ['Charlie High', 'final', null]);

  // A drawn final decides nothing, so the table does.
  fixtures[2].awayScore = 2;
  assert.equal(describe(comp(), fixtures, teams, TODAY).leader.name, 'Alpha High');
});

test('organiser dates: started means ongoing, an end date ahead keeps it ongoing, a past one ends it', () => {
  assert.equal(describe(comp({ start_date: '2026-11-01' }), [], teams, TODAY).status, 'ongoing');
  assert.equal(describe(comp({ end_date: '2026-12-31' }), [fx(1, 2, '2026-10-01', 1, 0)], teams, TODAY).status, 'ongoing');
  assert.equal(describe(comp({ start_date: '2026-03-01', end_date: '2026-04-01' }), [], teams, TODAY).status, 'completed');
  assert.equal(describe(comp(), [fx(1, 2, '2026-11-09', null, null, { status: 'live' })], teams, TODAY).status, 'ongoing');
  assert.equal(describe(comp(), [fx(1, 2, '2026-11-01', null, null, { status: 'postponed' })], teams, TODAY).status, 'ongoing');
});

test('cards sort ongoing, upcoming (soonest first), then completed (latest first)', () => {
  const cards = [
    { name: 'Old', status: 'completed', endDate: '2026-03-01' },
    { name: 'Later', status: 'upcoming', startDate: '2027-02-01' },
    { name: 'Recent', status: 'completed', endDate: '2026-06-01' },
    { name: 'Soon', status: 'upcoming', startDate: '2027-01-14' },
    { name: 'Live', status: 'ongoing', startDate: '2026-09-01' },
    { name: 'Undated', status: 'upcoming', startDate: null },
  ];
  assert.deepEqual(cards.sort(compare).map((c) => c.name), ['Live', 'Soon', 'Later', 'Undated', 'Recent', 'Old']);
});
