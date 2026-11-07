// Fills a DEVELOPMENT database with demo schools, teams, coaches, fixtures and results so the
// website and mobile app have something to show.
//
//   npm run seed:demo            adds the demo data (does nothing if it is already there)
//   npm run seed:demo -- --reset removes the demo data first, then adds it again
//
// Everything it creates is tied to accounts with an @demo.sportstures.test email, so --reset
// removes only that and never touches real users, schools or matches.
// Demo logins: coach1@demo.sportstures.test ... and learner@demo.sportstures.test, password DemoPass1
const bcrypt = require('bcrypt');

const DEMO_DOMAIN = 'demo.sportstures.test';
const DEMO_PASSWORD = 'DemoPass1';

const SCHOOLS = [
  { name: 'Northview High', town: 'Sandton', province: 'Gauteng', sports: ['Football', 'Rugby', 'Basketball', 'Cricket'] },
  { name: 'Riverside College', town: 'Pretoria', province: 'Gauteng', sports: ['Football', 'Rugby', 'Netball', 'Hockey'] },
  { name: 'Greenwood Academy', town: 'Alberton', province: 'Gauteng', sports: ['Football', 'Netball', 'Basketball', 'Volleyball'] },
  { name: 'Lakeside Collegiate', town: 'Cape Town', province: 'Western Cape', sports: ['Rugby', 'Netball', 'Cricket', 'Hockey'] },
  { name: 'Oakridge High', town: 'Stellenbosch', province: 'Western Cape', sports: ['Rugby', 'Cricket', 'Hockey', 'Football'] },
  { name: 'Hillcrest Secondary', town: 'Pinetown', province: 'KwaZulu-Natal', sports: ['Football', 'Rugby', 'Netball', 'Basketball'] },
  { name: 'Meadowbrook College', town: 'Pietermaritzburg', province: 'KwaZulu-Natal', sports: ['Football', 'Rugby', 'Cricket', 'Hockey'] },
  { name: 'Summit Park School', town: 'Bloemfontein', province: 'Free State', sports: ['Rugby', 'Netball', 'Volleyball', 'Football'] },
];

// How a final score looks in each sport. `draws: false` means a tie is nudged into a win.
const SCORING = {
  Football: { min: 0, max: 4, draws: true },
  Rugby: { min: 5, max: 40, draws: true },
  Netball: { min: 15, max: 50, draws: true },
  Basketball: { min: 40, max: 90, draws: false },
  Cricket: { min: 100, max: 250, draws: false },
  Hockey: { min: 0, max: 5, draws: true },
  Volleyball: { min: 0, max: 3, draws: false },
};

const GIRLS = new Set(['Netball']);
const BOYS = new Set(['Rugby']);

// Small deterministic random numbers, so every run produces the same demo league.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function removeDemoData(db) {
  const users = await db.query('SELECT id FROM users WHERE email LIKE $1', [`%@${DEMO_DOMAIN}`]);
  const ids = users.rows.map((u) => u.id);
  if (!ids.length) return 0;
  await db.query('DELETE FROM fixtures WHERE home_team_id IN (SELECT id FROM teams WHERE coach_id = ANY($1)) OR away_team_id IN (SELECT id FROM teams WHERE coach_id = ANY($1))', [ids]);
  await db.query('DELETE FROM teams WHERE coach_id = ANY($1)', [ids]);
  await db.query('DELETE FROM competitions WHERE created_by = ANY($1)', [ids]);
  await db.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
  // Only schools that nothing refers to any more, and only the demo ones.
  await db.query(
    `DELETE FROM schools s WHERE lower(btrim(s.name)) = ANY($1)
       AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.school_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM learner_profiles lp WHERE lp.user_id IS NOT NULL AND lp.school_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM coaches c WHERE c.school_id = s.id)`,
    [SCHOOLS.map((s) => s.name.toLowerCase())]
  );
  return ids.length;
}

async function sportId(db, name) {
  const found = await db.query('SELECT id FROM sports WHERE lower(name) = lower($1)', [name]);
  if (found.rows[0]) return found.rows[0].id;
  return (await db.query('INSERT INTO sports (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
}

// `db` is a pg Pool or Client. Returns a summary, or { skipped: true } if demo data already exists.
async function seedDemo(db, { reset = false, now = new Date() } = {}) {
  if (reset) await removeDemoData(db);
  const existing = await db.query('SELECT 1 FROM users WHERE email LIKE $1 LIMIT 1', [`%@${DEMO_DOMAIN}`]);
  if (existing.rows[0]) return { skipped: true };

  const random = rng(2026);
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const roleId = async (name) => (await db.query('SELECT id FROM roles WHERE name = $1', [name])).rows[0].id;
  const coachRole = await roleId('coach');
  const learnerRole = await roleId('learner');

  // Schools
  const schoolIds = {};
  for (const s of SCHOOLS) {
    const r = await db.query(
      `INSERT INTO schools (name, province, town) VALUES ($1, $2, $3)
       ON CONFLICT (lower(btrim(name))) DO UPDATE
         SET province = COALESCE(schools.province, EXCLUDED.province), town = COALESCE(schools.town, EXCLUDED.town)
       RETURNING id`,
      [s.name, s.province, s.town]
    );
    schoolIds[s.name] = r.rows[0].id;
  }

  // One coach and one team per school and sport (a coach may only have one team).
  const teamsBySport = {};
  let coachNumber = 0;
  let firstCoachId = null;
  for (const s of SCHOOLS) {
    for (const sport of s.sports) {
      coachNumber += 1;
      const email = `coach${coachNumber}@${DEMO_DOMAIN}`;
      const user = await db.query(
        `INSERT INTO users (email, password, first_name, last_name, role_id, email_verified)
         VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id`,
        [email, hash, 'Coach', `Demo ${coachNumber}`, coachRole]
      );
      const coachId = user.rows[0].id;
      firstCoachId = firstCoachId || coachId;
      const teamName = `${s.name} ${sport}`;
      const category = GIRLS.has(sport) ? 'girls' : BOYS.has(sport) ? 'boys' : 'mixed';
      await db.query(
        `INSERT INTO coaches (user_id, school_id, team_name, team_level, coaching_role, experience)
         VALUES ($1, $2, $3, '1st_team', 'head_coach', '3_5_years')`,
        [coachId, schoolIds[s.name], teamName]
      );
      const team = await db.query(
        `INSERT INTO teams (name, coach_id, school_id, sport_id, level, gender_category)
         VALUES ($1, $2, $3, $4, '1st_team', $5) RETURNING id`,
        [teamName, coachId, schoolIds[s.name], await sportId(db, sport), category]
      );
      (teamsBySport[sport] ||= []).push({ id: team.rows[0].id, school: s });
    }
  }

  // A league per sport with every team playing every other once. The first 60% are finished
  // (spread over the last 8 weeks); the rest are coming up (over the next 3 weeks).
  let fixtureCount = 0;
  let resultCount = 0;
  for (const [sport, teams] of Object.entries(teamsBySport)) {
    if (teams.length < 2 || !SCORING[sport]) continue;
    const comp = await db.query(
      `INSERT INTO competitions (name, sport_id, season, created_by) VALUES ($1, $2, '2026', $3) RETURNING id`,
      [`Schools League 2026 - ${sport}`, await sportId(db, sport), firstCoachId]
    );
    const pairs = [];
    for (let i = 0; i < teams.length; i += 1) {
      for (let j = i + 1; j < teams.length; j += 1) pairs.push([teams[i], teams[j]]);
    }
    const finishedCount = Math.ceil(pairs.length * 0.6);
    const scoring = SCORING[sport];
    for (const [index, [home, away]] of pairs.entries()) {
      const finished = index < finishedCount;
      const dayOffset = finished
        ? -Math.round(((finishedCount - index) / finishedCount) * 56)
        : 1 + Math.round(((index - finishedCount) / Math.max(1, pairs.length - finishedCount)) * 20);
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, 13, 0, 0));
      const fixture = await db.query(
        `INSERT INTO fixtures (home_team_id, away_team_id, match_date, location, status, competition_id, match_type)
         VALUES ($1, $2, $3, $4, $5, $6, 'league') RETURNING id`,
        [home.id, away.id, date.toISOString(), `${home.school.name} Sports Ground`, finished ? 'finished' : 'scheduled', comp.rows[0].id]
      );
      fixtureCount += 1;
      if (finished) {
        const pick = () => scoring.min + Math.floor(random() * (scoring.max - scoring.min + 1));
        let homeScore = pick();
        let awayScore = pick();
        if (!scoring.draws && homeScore === awayScore) homeScore += 1;
        await db.query('INSERT INTO scores (fixture_id, home_team_score, away_team_score) VALUES ($1, $2, $3)', [fixture.rows[0].id, homeScore, awayScore]);
        resultCount += 1;
      }
    }
  }

  // One demo learner on the first team's roster, for trying the player side.
  const firstTeam = (await db.query('SELECT id, school_id FROM teams WHERE coach_id = $1', [firstCoachId])).rows[0];
  const learner = await db.query(
    `INSERT INTO users (email, password, first_name, last_name, date_of_birth, gender, role_id, email_verified)
     VALUES ($1, $2, 'Demo', 'Learner', '2009-05-01', 'male', $3, TRUE) RETURNING id`,
    [`learner@${DEMO_DOMAIN}`, hash, learnerRole]
  );
  await db.query(
    `INSERT INTO learner_profiles (user_id, school_id, grade, class_name) VALUES ($1, $2, 10, '10A')`,
    [learner.rows[0].id, firstTeam.school_id]
  );
  await db.query(
    `INSERT INTO team_members (team_id, user_id, status, jersey_number, position, joined_at)
     VALUES ($1, $2, 'active', 7, 'Forward', CURRENT_TIMESTAMP)`,
    [firstTeam.id, learner.rows[0].id]
  );

  return {
    skipped: false,
    schools: SCHOOLS.length,
    teams: coachNumber,
    fixtures: fixtureCount,
    results: resultCount,
    password: DEMO_PASSWORD,
  };
}

module.exports = { seedDemo, removeDemoData, DEMO_DOMAIN, DEMO_PASSWORD };

if (require.main === module) {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to add demo data when NODE_ENV=production.');
    process.exit(1);
  }
  const pool = require('../db/config');
  const reset = process.argv.includes('--reset');
  (async () => {
    const target = `${pool.options.database} on ${pool.options.host}`;
    console.log(`${reset ? 'Resetting and adding' : 'Adding'} demo data in ${target}`);
    const result = await seedDemo(pool, { reset });
    if (result.skipped) {
      console.log('Demo data is already there. Run with --reset to rebuild it.');
    } else {
      console.log(`Added ${result.schools} schools, ${result.teams} teams, ${result.fixtures} fixtures (${result.results} with results).`);
      console.log(`Log in as coach1@${DEMO_DOMAIN} or learner@${DEMO_DOMAIN}, password ${result.password}`);
    }
    await pool.end();
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
