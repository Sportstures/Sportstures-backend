// Win/draw/loss maths for league tables and team records. Pure functions, no database.
//
// Points: win 3, draw 1, loss 0.
// Table order: points, then points difference (for minus against), then points for, then team name.

const POINTS = { win: 3, draw: 1, loss: 0 };
const FORM_LENGTH = 5;

const round1 = (n) => Math.round(n * 10) / 10;

// `results` is one team's played matches, oldest first: [{ pointsFor, pointsAgainst }].
function summarise(results) {
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
    points: summary.won * POINTS.win + summary.drawn * POINTS.draw + summary.lost * POINTS.loss,
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

// `teams`: every team in the competition, [{ id, name, ... }] (teams with no results still appear).
// Returns the table rows with positions. Teams level on every measure share a position.
function buildTable(teams, fixtures) {
  const byTeam = resultsByTeam(fixtures);

  const rows = teams.map((team) => ({ team, ...summarise(byTeam.get(team.id) || []) }));

  rows.sort((a, b) =>
    b.points - a.points
    || b.difference - a.difference
    || b.pointsFor - a.pointsFor
    || String(a.team.name).localeCompare(String(b.team.name)));

  let position = 0;
  return rows.map((row, index) => {
    const previous = rows[index - 1];
    const level = previous
      && previous.points === row.points
      && previous.difference === row.difference
      && previous.pointsFor === row.pointsFor;
    if (!level) position = index + 1;
    return { position, ...row };
  });
}

// One team's record from its finished fixtures.
function teamRecord(teamId, fixtures) {
  return summarise(resultsByTeam(fixtures).get(teamId) || []);
}

module.exports = { POINTS, FORM_LENGTH, summarise, buildTable, teamRecord };
