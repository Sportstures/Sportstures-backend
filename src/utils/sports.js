// Finds a sport by its trimmed, case-insensitive name or creates it.
// `db` can be the pool or a client inside a transaction.
async function findOrCreateSport(db, name) {
  const trimmedName = name.trim();
  const canonicalName = trimmedName.toLowerCase() === 'soccer' ? 'Football' : trimmedName;
  const inserted = await db.query(
    `INSERT INTO sports (name) VALUES ($1)
     ON CONFLICT (lower(btrim(name))) DO UPDATE SET name = sports.name
     RETURNING id, name`,
    [canonicalName]
  );
  return inserted.rows[0];
}

// The Favourite Sports screen's groups, in screen order. Sports without a category are "Other".
const CATEGORIES = [
  { key: 'team', label: 'Team Sports' },
  { key: 'athletics', label: 'Athletics & Endurance' },
  { key: 'racket', label: 'Racket Sports' },
  { key: 'water', label: 'Water Sports' },
  { key: 'combat', label: 'Combat Sports' },
  { key: 'precision', label: 'Precision & Outdoor' },
  { key: 'mind', label: 'Mind & Heritage' },
  { key: 'other', label: 'Other' },
];

const SPORT_SELECT = 'SELECT id, name, key, category FROM sports';
const mapSport = (r) => ({ id: r.id, name: r.name, key: r.key || null, category: r.category || 'other' });

module.exports = { findOrCreateSport, CATEGORIES, SPORT_SELECT, mapSport };
