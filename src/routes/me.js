const express = require('express');
const pool = require('../../db/config');
const { authenticate } = require('../middleware/auth');
const { teamSelect, teamJoins, mapTeam } = require('../utils/serializers');

const router = express.Router();

// GET /api/me/teams: the teams I am on, and the ones I have asked to join.
router.get('/teams', authenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT tm.status, tm.jersey_number, tm.position, tm.joined_at, tm.created_at, ${teamSelect('t', 't')}
         FROM team_members tm
         JOIN teams t ON t.id = tm.team_id
         ${teamJoins('t', 't')}
        WHERE tm.user_id = $1
        ORDER BY (tm.status = 'active') DESC, t.name`,
      [req.user.id]
    );
    res.json({
      teams: rows.map((r) => ({
        status: r.status,
        jerseyNumber: r.jersey_number,
        position: r.position,
        joinedAt: r.joined_at,
        requestedAt: r.created_at,
        team: mapTeam(r, 't'),
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
