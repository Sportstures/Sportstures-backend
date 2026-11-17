// Win/draw/loss maths for league tables and team records. Pure functions, no database.
//
// Points: by default win 3, draw 1, loss 0. A competition can change them (see `rules`).
// Table order: points first. Teams level on points are separated by the competition's tiebreakers,
// in order. The standard order is: points difference (for minus against), points for, head-to-head.

const POINTS = { win: 3, draw: 1, loss: 0 };
const FORM_LENGTH = 5;

// What a competition can use to separate teams that are level on points.
//   difference    higher (for minus against) first
//   for           more scored first
//   against       fewer conceded first
//   wins          more wins first
//   head_to_head  a mini-table of only the matches between the tied teams: points, then difference, then scored
const TIEBREAKERS = ['difference', 'for', 'against', 'wins', 'head_to_head'];
const DEFAULT_TIEBREAKERS = ['difference', 'for', 'head_to_head'];

const round1 = (n) => Math.round(n * 10) / 10;

// `rules`: { points: { win, draw, loss }, tiebreakers: [...] }. Anything missing uses the standard.
function resolveRules(rules = {}) {
  return {
    points: { ...POINTS, ...(rules.points || {}) },
    tiebreakers: rules.tiebreakers && rules.tiebreakers.length ? rules.tiebreakers : DEFAULT_TIEBREAKERS,
  };
}

// `results` is one team's played matches, oldest first: [{ pointsFor, pointsAgainst }].
function summarise(results, points = POINTS) {
  const summary = { played: 0, won: 0, drawn: 0, lost: 0, pointsFor: 0, pointsAgainst: 0 };
  const form = [];

  for (const r of results) {
    summary.played += 1;
    summary.pointsFor += r.pointsFor;
    summary.pointsAgainst += r.pointsAgainst;
    if (r.pointsFor > r.pointsAgainst) { summary.won += 1; form.push('W'); }
    else if (r.pointsFor < r.pointsAgainst) { summary.lost += 1; form.push('L'); }
    else { summary.drawn += 1; form.push('D'); }
  }

  return {
    ...summary,
    difference: summary.pointsFor - summary.pointsAgainst,
    points: summary.won * points.win + summary.drawn * points.draw + summary.lost * points.loss,
    winRate: summary.played ? round1((summary.won / summary.played) * 100) : null,
    averageScored: summary.played ? round1(summary.pointsFor / summary.played) : null,
    averageConceded: summary.played ? round1(summary.pointsAgainst / summary.played) : null,
    form: form.slice(-FORM_LENGTH), // last five, oldest first
  };
}

// Turns finished fixtures into one list of results per team.
// `fixtures`: [{ homeTeamId, awayTeamId, homeScore, awayScore }], oldest first.
function resultsByTeam(fixtures) {
  const byTeam = new Map();
  const add = (teamId, pointsFor, pointsAgainst) => {
    if (!byTeam.has(teamId)) byTeam.set(teamId, []);
    byTeam.get(teamId).push({ pointsFor, pointsAgainst });
  };
  for (const f of fixtures) {
    add(f.homeTeamId, f.homeScore, f.awayScore);
    add(f.awayTeamId, f.awayScore, f.homeScore);
  }
  return byTeam;
}

// Splits rows into groups that are level on `key`, best group first. `key` returns a list of numbers
// where a bigger number is better, compared in order.
function partition(rows, key) {
  const sorted = [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  });
  const groups = [];
  for (const row of sorted) {
    const last = groups[groups.length - 1];
    if (last && key(last[0]).every((v, i) => v === key(row)[i])) last.push(row);
    else groups.push([row]);
  }
  return groups;
}

// The tiebreak for one group of teams that are level so far, using the first of `criteria`.
// Returns the group split into ordered sub-groups, or the same group if this criterion cannot separate it.
function splitBy(group, criterion, fixtures, points) {
  switch (criterion) {
    case 'difference': return partition(group, (r) => [r.difference]);
    case 'for': return partition(group, (r) => [r.pointsFor]);
    case 'against': return partition(group, (r) => [-r.pointsAgainst]);
    case 'wins': return partition(group, (r) => [r.won]);
    case 'head_to_head': {
      const ids = new Set(group.map((r) => r.team.id));
      const between = fixtures.filter((f) => ids.has(f.homeTeamId) && ids.has(f.awayTeamId));
      const mini = new Map([...resultsByTeam(between)].map(([id, results]) => [id, summarise(results, points)]));
      const of = (r) => mini.get(r.team.id) || { points: 0, difference: 0, pointsFor: 0 };
      return partition(group, (r) => [of(r).points, of(r).difference, of(r).pointsFor]);
    }
    default: return [group];
  }
}

// Orders a group of teams that are level on points. Each tiebreaker is applied in turn to whoever is
// still level. Rows get `tiebreaker`: the rule that finally separated them (null when points did it).
let levelCounter = 0;

function settle(group, criteria, fixtures, points, order) {
  if (group.length === 1) { order.push(group[0]); return; }
  for (let i = 0; i < criteria.length; i += 1) {
    const parts = splitBy(group, criteria[i], fixtures, points);
    if (parts.length === 1) continue;
    for (const row of group) row.tiebreaker = criteria[i];
    for (const part of parts) settle(part, criteria.slice(i + 1), fixtures, points, order);
    return;
  }
  // Still level on everything: they share a position and are listed by name.
  levelCounter += 1;
  group.sort((a, b) => String(a.team.name).localeCompare(String(b.team.name)));
  for (const row of group) { row.level = levelCounter; order.push(row); }
}

// `teams`: every team in the competition, [{ id, name, ... }] (teams with no results still appear).
// `rules` is optional (see resolveRules). Returns the table rows with positions. Teams level after every
// tiebreaker share a position.
function buildTable(teams, fixtures, rules) {
  const { points, tiebreakers } = resolveRules(rules);
  const byTeam = resultsByTeam(fixtures);
  const rows = teams.map((team) => ({ team, ...summarise(byTeam.get(team.id) || [], points), tiebreaker: null }));

  const order = [];
  const byPoints = partition(rows, (r) => [r.points]);
  for (const group of byPoints) settle(group, tiebreakers, fixtures, points, order);

  // Teams still level after every tiebreaker (same `level` marker) share a position.
  let position = 0;
  return order.map((row, index) => {
    const previous = order[index - 1];
    if (!previous || previous.level !== row.level || row.level === undefined) position = index + 1;
    const { level, ...clean } = row;
    return { position, ...clean };
  });
}

// One team's record from its finished fixtures.
function teamRecord(teamId, fixtures) {
  return summarise(resultsByTeam(fixtures).get(teamId) || []);
}

module.exports = {
  POINTS, FORM_LENGTH, TIEBREAKERS, DEFAULT_TIEBREAKERS, resolveRules, summarise, buildTable, teamRecord,
};
