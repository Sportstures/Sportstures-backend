// The signed-in person's notifications inbox and settings. Mounted at /api/me/notifications.
const express = require('express');
const { body, query, param } = require('express-validator');
const pool = require('../../db/config');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { errorBody } = require('../utils/serializers');
const { CATEGORIES, CATEGORY_OF } = require('../utils/notifications');

const router = express.Router();
router.use(authenticate);

function mapNotification(r) {
  return {
    id: Number(r.id),
    type: r.type,
    category: CATEGORY_OF[r.type] || null,
    title: r.title,
    body: r.body,
    data: r.data,
    read: r.read_at !== null,
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

const unreadCount = async (userId) => (await pool.query(
  'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]
)).rows[0].n;

// ------------------------------------------------------------------ settings

async function loadSettings(userId) {
  const { rows: [row] } = await pool.query('SELECT * FROM notification_settings WHERE user_id = $1', [userId]);
  return Object.fromEntries(Object.entries(CATEGORIES).map(([key, c]) => [key, row ? row[c.column] : true]));
}

// GET /api/me/notifications/settings: { settings: { matchResults: true, ... } }. Everything is on until changed.
router.get('/settings', async (req, res, next) => {
  try {
    res.json({ settings: await loadSettings(req.user.id) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/me/notifications/settings  { "matchResults": false }: only the settings sent change.
router.put(
  '/settings',
  Object.keys(CATEGORIES).map((key) => body(key).optional().isBoolean({ strict: true }).withMessage(`${key} must be true or false`)),
  validate,
  async (req, res, next) => {
    try {
      const keys = Object.keys(CATEGORIES).filter((key) => req.body[key] !== undefined);
      if (!keys.length) {
        return res.status(400).json(errorBody('NOTHING_TO_UPDATE', `Send at least one of: ${Object.keys(CATEGORIES).join(', ')}`));
      }
      const columns = keys.map((key) => CATEGORIES[key].column);
      const values = keys.map((key) => req.body[key]);
      await pool.query(
        `INSERT INTO notification_settings (user_id, ${columns.join(', ')})
         VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (user_id) DO UPDATE
           SET ${columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = CURRENT_TIMESTAMP`,
        [req.user.id, ...values]
      );
      res.json({ settings: await loadSettings(req.user.id) });
    } catch (err) {
      next(err);
    }
  }
);

// ------------------------------------------------------------------ the inbox

// GET /api/me/notifications?unread=true&limit=&offset=  Newest first.
router.get(
  '/',
  [
    query('unread').optional().isBoolean().withMessage('unread must be true or false').toBoolean(),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be 1 to 100').toInt(),
    query('offset').optional().isInt({ min: 0 }).withMessage('offset must be 0 or more').toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const limit = req.query.limit || 20;
      const offset = req.query.offset || 0;
      const where = `WHERE user_id = $1${req.query.unread ? ' AND read_at IS NULL' : ''}`;
      const [list, total, unread] = await Promise.all([
        pool.query(
          `SELECT * FROM notifications ${where} ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
          [req.user.id, limit, offset]
        ),
        pool.query(`SELECT count(*)::int AS n FROM notifications ${where}`, [req.user.id]),
        unreadCount(req.user.id),
      ]);
      res.json({
        notifications: list.rows.map(mapNotification),
        unreadCount: unread,
        total: total.rows[0].n,
        limit,
        offset,
        hasMore: offset + list.rows.length < total.rows[0].n,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/me/notifications/unread-count: { unreadCount } for the bell badge. Cheap to poll.
router.get('/unread-count', async (req, res, next) => {
  try {
    res.json({ unreadCount: await unreadCount(req.user.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/me/notifications/read-all: mark everything read.
router.post('/read-all', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      'UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND read_at IS NULL', [req.user.id]
    );
    res.json({ marked: rowCount, unreadCount: 0 });
  } catch (err) {
    next(err);
  }
});

const idParam = param('id').isInt({ min: 1 }).withMessage('id must be a number').toInt();

// PUT /api/me/notifications/:id/read (mark read) and DELETE /api/me/notifications/:id/read (mark unread).
const markRead = (on) => async (req, res, next) => {
  try {
    const { rows: [row] } = await pool.query(
      `UPDATE notifications SET read_at = ${on ? 'COALESCE(read_at, CURRENT_TIMESTAMP)' : 'NULL'}
        WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!row) return res.status(404).json(errorBody('NOT_FOUND', 'Notification not found'));
    res.json({ notification: mapNotification(row), unreadCount: await unreadCount(req.user.id) });
  } catch (err) {
    next(err);
  }
};
router.put('/:id/read', [idParam], validate, markRead(true));
router.delete('/:id/read', [idParam], validate, markRead(false));

// DELETE /api/me/notifications/:id: remove one from the inbox.
router.delete('/:id', [idParam], validate, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!rowCount) return res.status(404).json(errorBody('NOT_FOUND', 'Notification not found'));
    res.json({ deleted: true, unreadCount: await unreadCount(req.user.id) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
