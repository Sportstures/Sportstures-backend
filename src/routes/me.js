const express = require('express');
const pool = require('../../db/config');
const { authenticate } = require('../middleware/auth');
const multer = require('multer');
const { teamSelect, teamJoins, mapTeam, errorBody } = require('../utils/serializers');
const storage = require('../utils/storage');
const { imageType } = require('../utils/images');

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

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

// Keeps the upload in memory (it goes straight on to Cloudinary) and turns multer's errors into ours.
function receivePhoto(req, res, next) {
  multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AVATAR_BYTES, files: 1 } })
    .single('photo')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json(errorBody('FILE_TOO_LARGE', 'The photo must be 5 MB or smaller'));
      }
      if (err instanceof multer.MulterError) {
        return res.status(400).json(errorBody('INVALID_UPLOAD', 'Send one image in a form field named "photo"'));
      }
      return next(err);
    });
}

// PUT /api/me/avatar: upload or replace my profile photo (multipart/form-data, field "photo").
router.put('/avatar', authenticate, receivePhoto, async (req, res, next) => {
  try {
    if (!storage.isConfigured()) {
      return res.status(503).json(errorBody('STORAGE_UNAVAILABLE', 'Photo uploads are not set up on this server'));
    }
    if (!req.file) {
      return res.status(400).json(errorBody('NO_FILE', 'Send the image in a form field named "photo"'));
    }
    if (!imageType(req.file.buffer)) {
      return res.status(400).json(errorBody('INVALID_IMAGE', 'The photo must be a JPEG, PNG, WebP or HEIC image'));
    }

    let uploaded;
    try {
      uploaded = await storage.uploadAvatar(req.file.buffer, req.user.id);
    } catch (err) {
      console.error('Avatar upload failed:', err.message);
      return res.status(502).json(errorBody('UPLOAD_FAILED', 'The photo could not be saved. Please try again'));
    }

    await pool.query(
      'UPDATE users SET avatar_url = $1, avatar_public_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [uploaded.url, uploaded.publicId, req.user.id]
    );
    res.json({ avatarUrl: uploaded.url });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/me/avatar: remove my profile photo.
router.delete('/avatar', authenticate, async (req, res, next) => {
  try {
    const { rows: [row] } = await pool.query('SELECT avatar_public_id FROM users WHERE id = $1', [req.user.id]);
    if (row && row.avatar_public_id && storage.isConfigured()) {
      try {
        await storage.deleteImage(row.avatar_public_id);
      } catch (err) {
        // The photo is unlinked either way; a leftover file in Cloudinary is harmless.
        console.error('Avatar delete failed:', err.message);
      }
    }
    await pool.query(
      'UPDATE users SET avatar_url = NULL, avatar_public_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [req.user.id]
    );
    res.json({ avatarUrl: null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
