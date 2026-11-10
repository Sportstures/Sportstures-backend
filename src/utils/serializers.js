// SQL fragments and mappers so teams and fixtures look the same in every endpoint.
const { ageGroupOf } = require('./rankings');

function errorBody(code, message) {
  return { error: { code, message } };
}

// Columns for a team joined as `alias`, with output names prefixed by `p` (e.g. h_id, h_name).
// Needs the joins from teamJoins(alias, p).
function teamSelect(alias, p) {
  return `${alias}.id AS ${p}_id, ${alias}.name AS ${p}_name, ${alias}.level AS ${p}_level,
    ${alias}.gender_category AS ${p}_gender_category,
    ${p}_sp.id AS ${p}_sport_id, ${p}_sp.name AS ${p}_sport_name,
    ${p}_sc.id AS ${p}_school_id, ${p}_sc.name AS ${p}_school_name,
    ${p}_sc.province AS ${p}_school_province, ${p}_sc.town AS ${p}_school_town`;
}

function teamJoins(alias, p) {
  return `LEFT JOIN sports ${p}_sp ON ${p}_sp.id = ${alias}.sport_id
    LEFT JOIN schools ${p}_sc ON ${p}_sc.id = ${alias}.school_id`;
}

function mapTeam(row, p) {
  return {
    id: row[`${p}_id`],
    name: row[`${p}_name`],
    level: row[`${p}_level`],
    genderCategory: row[`${p}_gender_category`],
    sport: row[`${p}_sport_id`] ? { id: row[`${p}_sport_id`], name: row[`${p}_sport_name`] } : null,
    school: row[`${p}_school_id`]
      ? {
        id: row[`${p}_school_id`],
        name: row[`${p}_school_name`],
        province: row[`${p}_school_province`] || null,
        town: row[`${p}_school_town`] || null,
      }
      : null,
  };
}

const FIXTURE_SELECT = `f.id, f.match_date, f.status, f.location AS venue, f.match_type,
    f.competition_id, comp.name AS competition_name,
    hmt.coach_id AS h_coach_id, hcu.id AS h_coach_user_id,
    amt.coach_id AS a_coach_id, acu.id AS a_coach_user_id,
    ${teamSelect('hmt', 'h')},
    ${teamSelect('amt', 'a')},
    sc.home_team_score, sc.away_team_score,
    EXISTS (SELECT 1 FROM fixture_reports fr WHERE fr.fixture_id = f.id) AS report_filed,
    EXISTS (SELECT 1 FROM fixture_lineups fl WHERE fl.fixture_id = f.id AND fl.team_id = f.home_team_id) AS home_lineup_submitted,
    EXISTS (SELECT 1 FROM fixture_lineups fl WHERE fl.fixture_id = f.id AND fl.team_id = f.away_team_id) AS away_lineup_submitted`;

const FIXTURE_FROM = `FROM fixtures f
    JOIN teams hmt ON hmt.id = f.home_team_id
    JOIN teams amt ON amt.id = f.away_team_id
    ${teamJoins('hmt', 'h')}
    ${teamJoins('amt', 'a')}
    LEFT JOIN users hcu ON hcu.id = hmt.coach_id
    LEFT JOIN users acu ON acu.id = amt.coach_id
    LEFT JOIN competitions comp ON comp.id = f.competition_id
    LEFT JOIN scores sc ON sc.fixture_id = f.id`;

// 'home', 'away' or 'draw' once a fixture is finished with a score, otherwise null.
function winnerOf(row) {
  if (row.status !== 'finished' || row.home_team_score === null || row.home_team_score === undefined) return null;
  if (row.home_team_score > row.away_team_score) return 'home';
  if (row.home_team_score < row.away_team_score) return 'away';
  return 'draw';
}

function mapFixture(row) {
  const homeTeam = mapTeam(row, 'h');
  const awayTeam = mapTeam(row, 'a');
  return {
    id: row.id,
    matchDate: row.match_date,
    status: row.status,
    venue: row.venue,
    matchType: row.match_type,
    competition: row.competition_id ? { id: row.competition_id, name: row.competition_name } : null,
    sport: homeTeam.sport || awayTeam.sport,
    homeTeam,
    awayTeam,
    score: row.home_team_score === null || row.home_team_score === undefined
      ? null
      : { home: row.home_team_score, away: row.away_team_score },
    winner: winnerOf(row),
    reportFiled: Boolean(row.report_filed),
    lineupSubmitted: { home: Boolean(row.home_lineup_submitted), away: Boolean(row.away_lineup_submitted) },
  };
}

// "u19" -> "U/19", "1st_team" -> "1st Team"; free text such as "Varsity" is kept.
function levelLabel(level) {
  const value = (level || '').trim();
  const under = /^u\s*\/?\s*(\d+)$/i.exec(value);
  if (under) return `U/${under[1]}`;
  if (value.toLowerCase() === '1st_team') return '1st Team';
  if (value.toLowerCase() === '2nd_team') return '2nd Team';
  return value.replace(/_/g, ' ');
}

// The label the result and fixture cards show, e.g. "Football U/19" or "Girls Netball 1st Team".
function categoryLabel(team, sport) {
  return [
    team && team.genderCategory === 'girls' ? 'Girls' : '',
    sport ? sport.name : '',
    levelLabel(team && team.level),
  ].filter(Boolean).join(' ');
}

// A team with its description, coach and active player count: the shape every team endpoint returns.
const FULL_TEAM_SELECT = `SELECT ${teamSelect('t', 't')},
    t.description, t.location, t.founded_year, t.coach_id,
    cu.id AS coach_user_id, cu.first_name AS coach_first_name, cu.last_name AS coach_last_name,
    (SELECT count(*)::int FROM team_members tm WHERE tm.team_id = t.id AND tm.status = 'active') AS player_count
  FROM teams t
  ${teamJoins('t', 't')}
  LEFT JOIN users cu ON cu.id = t.coach_id`;

function mapFullTeam(r) {
  const team = mapTeam(r, 't');
  return {
    ...team,
    ageGroup: ageGroupOf(team.level), // "U/14", "U/16", "U/19" or "Open", as the app's filters use
    description: r.description,
    location: r.location,
    foundedYear: r.founded_year,
    playerCount: r.player_count,
    coach: r.coach_user_id
      ? { id: r.coach_user_id, name: [r.coach_first_name, r.coach_last_name].filter(Boolean).join(' ') || null }
      : null,
  };
}

module.exports = {
  errorBody, teamSelect, teamJoins, mapTeam, FIXTURE_SELECT, FIXTURE_FROM, mapFixture, FULL_TEAM_SELECT, mapFullTeam,
  levelLabel, categoryLabel,
};
