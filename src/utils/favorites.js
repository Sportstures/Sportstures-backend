const pool = require('../../db/config');

// Adds favorite: true/false to each team for a signed-in person (false for anonymous visitors).
async function withFavorites(teams, user) {
  if (!user || !teams.length) return teams.map((t) => ({ ...t, favorite: false }));
  const { rows } = await pool.query(
    'SELECT team_id FROM user_favorite_teams WHERE user_id = $1 AND team_id = ANY($2)',
    [user.id, teams.map((t) => t.id)]
  );
  const favourite = new Set(rows.map((r) => r.team_id));
  return teams.map((t) => ({ ...t, favorite: favourite.has(t.id) }));
}

// The ids of the schools a signed-in person follows.
async function followedSchoolIds(user) {
  if (!user) return new Set();
  const { rows } = await pool.query('SELECT school_id FROM user_followed_schools WHERE user_id = $1', [user.id]);
  return new Set(rows.map((r) => r.school_id));
}

// The feed: a fixture (with FIXTURE_FROM's hmt/amt team aliases) involving a favourite team or a followed
// school, or in a favourite sport. With nothing picked at all, every fixture. Every ? is the user's id.
const FEED_CONDITION = `((NOT EXISTS (SELECT 1 FROM user_favorite_teams WHERE user_id = ?)
      AND NOT EXISTS (SELECT 1 FROM user_followed_schools WHERE user_id = ?)
      AND NOT EXISTS (SELECT 1 FROM user_favorite_sports WHERE user_id = ?))
    OR f.home_team_id IN (SELECT team_id FROM user_favorite_teams WHERE user_id = ?)
    OR f.away_team_id IN (SELECT team_id FROM user_favorite_teams WHERE user_id = ?)
    OR hmt.school_id IN (SELECT school_id FROM user_followed_schools WHERE user_id = ?)
    OR amt.school_id IN (SELECT school_id FROM user_followed_schools WHERE user_id = ?)
    OR hmt.sport_id IN (SELECT sport_id FROM user_favorite_sports WHERE user_id = ?)
    OR amt.sport_id IN (SELECT sport_id FROM user_favorite_sports WHERE user_id = ?))`;

module.exports = { withFavorites, followedSchoolIds, FEED_CONDITION };
