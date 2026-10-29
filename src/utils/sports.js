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

module.exports = { findOrCreateSport };
