const PROVINCES = [
  'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo',
  'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape',
];

// Finds a school by name (ignoring case and surrounding spaces) or creates it.
// `location` ({ province, town }) is optional. It only FILLS EMPTY fields on an existing school,
// so a signup can never overwrite a location someone set on purpose.
// `db` can be the pool or a client inside a transaction.
async function findOrCreateSchool(db, name, location = {}) {
  const province = location.province || null;
  const town = location.town ? location.town.trim() || null : null;
  const inserted = await db.query(
    `INSERT INTO schools (name, province, town) VALUES ($1, $2, $3)
     ON CONFLICT (lower(btrim(name))) DO UPDATE
       SET province = COALESCE(schools.province, EXCLUDED.province),
           town = COALESCE(schools.town, EXCLUDED.town)
     RETURNING id`,
    [name.trim(), province, town]
  );
  return inserted.rows[0].id;
}

module.exports = { PROVINCES, findOrCreateSchool };
