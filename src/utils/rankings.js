// Ranking points for the learner Rankings screen. Pure functions, no database.
//
// Every finished match is worth up to 100 points to each team that played it, split the way the
// screen's "Ranking breakdown" card shows:
//
//   Match Wins              40   a win earns 40, a draw 20, a loss 0
//   Strength of Opposition  25   25 x the opponent's season record (wins + half the draws, over matches played)
//   Goals Scored            20   20 x the team's share of the match score (a 0-0 gives each side 10)
//   Consistency             10   10 when the team is unbeaten in this match AND its previous one
//   Participation            5   5 for turning up
//
// A team's ranking points are the sum over its matches, so playing (and winning) more counts.
// Schools add up their teams; regions average their schools; athletes earn their team's match
// points for every match they were in the lineup for (bench players earn half).

const BREAKDOWN = [
  { key: 'wins', label: 'Match Wins', weight: 0.40, description: 'A win earns 40 points and a draw 20.' },
  { key: 'opposition', label: 'Strength of Opposition', weight: 0.25, description: "Up to 25 points, scaled by the opponent's season record." },
  { key: 'scoring', label: 'Goals Scored', weight: 0.20, description: "Up to 20 points, by the team's share of the match score." },
  { key: 'consistency', label: 'Consistency', weight: 0.10, description: '10 points for each match unbeaten straight after another unbeaten match.' },
  { key: 'participation', label: 'Participation', weight: 0.05, description: '5 points for every match played.' },
];
const MAX = Object.fromEntries(BREAKDOWN.map((b) => [b.key, b.weight * 100]));

const BENCH_SHARE = 0.5;

const AGE_GROUPS = ['U/14', 'U/16', 'U/19', 'Open'];

// "u14" -> "U/14", "U/15" and "u16" -> "U/16", "u17" to "u19" -> "U/19"; anything else
// ("1st_team", "2nd_team", "Varsity", none) is "Open".
function ageGroupOf(level) {
  const under = /^u\s*\/?\s*(\d+)$/i.exec((level || '').trim());
  if (!under) return 'Open';
  const age = Number(under[1]);
  if (age <= 14) return 'U/14';
  if (age <= 16) return 'U/16';
  if (age <= 19) return 'U/19';
  return 'Open';
}

const emptyRecord = () => ({
  points: 0, played: 0, won: 0, drawn: 0, lost: 0,
  breakdown: { wins: 0, opposition: 0, scoring: 0, consistency: 0, participation: 0 },
});

// `matches`: [{ id, homeTeamId, awayTeamId, homeScore, awayScore }], oldest first.
// Returns { teams: Map(teamId -> record), byMatch: Map(matchId -> Map(teamId -> { points, result, parts })) },
// where result is 1 win, 0 draw, -1 loss and parts is that match's points per breakdown key.
// Points are left unrounded so sums stay exact; round when showing them.
function scoreTeams(matches) {
  // Season record of every team, for strength of opposition.
  const record = new Map();
  const tally = (id, result) => {
    const r = record.get(id) || { played: 0, score: 0 };
    r.played += 1;
    r.score += result;
    record.set(id, r);
  };
  for (const m of matches) {
    const home = Math.sign(m.homeScore - m.awayScore); // 1 home win, 0 draw, -1 away win
    tally(m.homeTeamId, (home + 1) / 2);
    tally(m.awayTeamId, (1 - home) / 2);
  }
  const strength = (id) => { const r = record.get(id); return r.score / r.played; };

  const teams = new Map();
  const byMatch = new Map();
  const lastUnbeaten = new Map();

  const add = (matchId, teamId, opponentId, scored, conceded) => {
    const result = Math.sign(scored - conceded);
    const unbeaten = result >= 0;
    const parts = {
      wins: MAX.wins * ((result + 1) / 2),
      opposition: MAX.opposition * strength(opponentId),
      scoring: MAX.scoring * (scored + conceded ? scored / (scored + conceded) : 0.5),
      consistency: unbeaten && lastUnbeaten.get(teamId) ? MAX.consistency : 0,
      participation: MAX.participation,
    };
    lastUnbeaten.set(teamId, unbeaten);

    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    const r = teams.get(teamId) || emptyRecord();
    r.points += total;
    r.played += 1;
    if (result > 0) r.won += 1; else if (result < 0) r.lost += 1; else r.drawn += 1;
    for (const [key, value] of Object.entries(parts)) r.breakdown[key] += value;
    teams.set(teamId, r);

    if (!byMatch.has(matchId)) byMatch.set(matchId, new Map());
    byMatch.get(matchId).set(teamId, { points: total, result, parts });
  };

  for (const m of matches) {
    add(m.id, m.homeTeamId, m.awayTeamId, m.homeScore, m.awayScore);
    add(m.id, m.awayTeamId, m.homeTeamId, m.awayScore, m.homeScore);
  }
  return { teams, byMatch };
}

// Adds records together (a school's teams, an athlete's matches).
function addRecords(records) {
  const total = emptyRecord();
  for (const r of records) {
    total.points += r.points;
    total.played += r.played;
    total.won += r.won;
    total.drawn += r.drawn;
    total.lost += r.lost;
    for (const key of Object.keys(total.breakdown)) total.breakdown[key] += r.breakdown[key];
  }
  return total;
}

const roundRecord = (r) => ({
  ...r,
  points: Math.round(r.points),
  breakdown: Object.fromEntries(Object.entries(r.breakdown).map(([k, v]) => [k, Math.round(v)])),
});

// Sorts entries ([{ key, name, points, ... }]) by points, most first, then name, and numbers them.
// Entries on the same (rounded) points share a position.
function rank(entries) {
  const rows = entries.map(roundRecord)
    .sort((a, b) => b.points - a.points || String(a.name).localeCompare(String(b.name)));
  let position = 0;
  return rows.map((row, index) => {
    if (index === 0 || rows[index - 1].points !== row.points) position = index + 1;
    return { position, ...row };
  });
}

// Adds previousPosition and trend (places moved up; negative is down) from last week's ranking.
// Entries that were not ranked last week get null for both.
function withTrend(current, previous) {
  const before = new Map(previous.map((r) => [r.key, r.position]));
  return current.map((row) => {
    const previousPosition = before.has(row.key) ? before.get(row.key) : null;
    return { ...row, previousPosition, trend: previousPosition === null ? null : previousPosition - row.position };
  });
}

module.exports = { BREAKDOWN, BENCH_SHARE, AGE_GROUPS, ageGroupOf, scoreTeams, addRecords, rank, withTrend };
