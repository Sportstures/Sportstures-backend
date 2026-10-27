// Finds a school by name (ignoring case) or creates it.
// `db` can be the pool or a client inside a transaction.
async function findOrCreateSchool(db, name) {
  const inserted = await db.query(
    'INSERT INTO schools (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id',
    [name]
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = await db.query('SELECT id FROM schools WHERE lower(name) = lower($1)', [name]);
  return existing.rows[0].id;
}

module.exports = { findOrCreateSchool };
