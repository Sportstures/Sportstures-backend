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

module.exports = { withFavorites };
