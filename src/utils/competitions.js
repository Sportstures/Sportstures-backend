// What the Competitions screen shows about a competition, worked out from its fixtures.
// Pure functions, no database.
const { buildTable } = require('./standings');

const STATUSES = ['ongoing', 'upcoming', 'completed'];
const NATIONAL = 'National';
const PENDING = new Set(['scheduled', 'live', 'postponed']);

const teamRef = (team) => ({
  id: team.id, name: team.name, level: team.level, genderCategory: team.genderCategory, ageGroup: team.ageGroup,
});

// `competition`: a competitions row (province, age_group, start_date, end_date and total_rounds may be null).
// `fixtures`: its non-cancelled fixtures, oldest first:
//   [{ id, homeTeamId, awayTeamId, status, matchType, day: 'YYYY-MM-DD' (South African), homeScore, awayScore }]
// `teams`: Map(teamId -> team as mapTeam returns it, plus ageGroup).
// `today`: 'YYYY-MM-DD' in South Africa. Dates compare as text because they are all YYYY-MM-DD.
function describe(competition, fixtures, teams, today) {
  const finished = fixtures.filter((f) => f.status === 'finished' && f.homeScore !== null && f.homeScore !== undefined);
  const pending = fixtures.filter((f) => PENDING.has(f.status));
  const startDate = competition.start_date || (fixtures[0] && fixtures[0].day) || null;
  const endDate = competition.end_date || (fixtures.length ? fixtures[fixtures.length - 1].day : null);

  // Completed once nothing is left to play (and the organiser's end date, if set, has passed).
  // Ongoing once a match is played or under way, or the start date has come.
  let status;
  const endAhead = competition.end_date && competition.end_date >= today;
  if (!pending.length && !endAhead && (finished.length || (endDate && endDate < today))) status = 'completed';
  else if (finished.length || fixtures.some((f) => f.status === 'live') || (startDate && startDate <= today)) status = 'ongoing';
  else status = 'upcoming';

  const ids = [...new Set(fixtures.flatMap((f) => [f.homeTeamId, f.awayTeamId]))];
  const entrants = ids.map((id) => teams.get(id)).filter(Boolean);

  // A round is one match per team, so the team with the most fixtures gives the number of rounds
  // (unless the organiser set it). Rounds played follow the share of fixtures played, never reaching
  // the last round while matches are still to come.
  const count = new Map();
  for (const f of fixtures) for (const id of [f.homeTeamId, f.awayTeamId]) count.set(id, (count.get(id) || 0) + 1);
  const totalRounds = competition.total_rounds || Math.max(0, ...count.values());
  let roundsPlayed = fixtures.length ? Math.round((finished.length / fixtures.length) * totalRounds) : 0;
  if (finished.length) roundsPlayed = Math.max(1, roundsPlayed);
  if (pending.length && totalRounds > 1) roundsPlayed = Math.min(roundsPlayed, totalRounds - 1);

  const provinces = new Set(entrants.map((t) => t.school && t.school.province).filter(Boolean));
  const region = competition.province
    || (provinces.size === 1 ? [...provinces][0] : provinces.size > 1 ? NATIONAL : null);
  const ageGroups = new Set(entrants.map((t) => t.ageGroup));
  const ageGroup = competition.age_group || (ageGroups.size === 1 ? [...ageGroups][0] : null);

  return {
    status,
    region,
    ageGroup,
    startDate,
    endDate,
    teams: ids.length,
    roundsPlayed,
    totalRounds,
    leader: status === 'upcoming' ? null : leaderOf(finished, entrants, teams),
  };
}

// The winner of a decided final, otherwise the top of the table. Null before any result.
function leaderOf(finished, entrants, teams) {
  if (!finished.length) return null;
  const final = finished.filter((f) => f.matchType === 'championship' && f.homeScore !== f.awayScore).pop();
  if (final) {
    const team = teams.get(final.homeScore > final.awayScore ? final.homeTeamId : final.awayTeamId);
    return team ? { name: team.school ? team.school.name : team.name, team: teamRef(team), school: team.school, points: null, decidedBy: 'final' } : null;
  }
  const [top] = buildTable(entrants, finished.map((f) => ({
    homeTeamId: f.homeTeamId, awayTeamId: f.awayTeamId, homeScore: f.homeScore, awayScore: f.awayScore,
  })));
  if (!top) return null;
  return { name: top.team.school ? top.team.school.name : top.team.name, team: teamRef(top.team), school: top.team.school, points: top.points, decidedBy: 'table' };
}

// Ongoing first (started earliest first), then upcoming (soonest first), then completed (latest first).
function compare(a, b) {
  const byStatus = STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status);
  if (byStatus) return byStatus;
  const date = a.status === 'completed'
    ? String(b.endDate || '').localeCompare(String(a.endDate || ''))
    : String(a.startDate || '9999').localeCompare(String(b.startDate || '9999'));
  return date || a.name.localeCompare(b.name);
}

module.exports = { STATUSES, NATIONAL, describe, compare };
