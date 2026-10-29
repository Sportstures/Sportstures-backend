// `db` can be the pool or a client inside a transaction.
async function findOrCreateSchool(db, name) {
  const inserted = await db.query(
    `INSERT INTO schools (name) VALUES ($1)
     ON CONFLICT (lower(btrim(name))) DO UPDATE SET name = schools.name
     RETURNING id`,
    [name.trim()]
  );
  return inserted.rows[0].id;
}

module.exports = { findOrCreateSchool };
