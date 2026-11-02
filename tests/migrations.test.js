const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');
const { connection, applySchema, migrationFiles } = require('./helpers/setup');

// Builds a throwaway database, runs the callback with a pool, then drops it.
async function withTempDatabase(fn) {
  const name = `sportstures_migtest_${process.pid}_${Date.now()}`;
  const admin = new Client({ ...connection, database: 'postgres' });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new Pool({ ...connection, database: name });
  try {
    await fn(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
}

test('a fresh install (schema.sql plus every migration) works and creates the expected tables', async () => {
  await withTempDatabase(async (pool) => {
    await applySchema(pool);
    const { rows } = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    const tables = rows.map((r) => r.table_name);
    for (const expected of [
      'users', 'roles', 'refresh_tokens', 'email_verification_codes', 'schools', 'sports',
      'learner_profiles', 'coaches', 'teams', 'competitions', 'fixtures', 'scores',
    ]) {
      assert.ok(tables.includes(expected), `missing table ${expected}`);
    }
    const roles = await pool.query('SELECT name FROM roles ORDER BY name');
    assert.deepEqual(roles.rows.map((r) => r.name), ['admin', 'coach', 'learner']);
    const column = await pool.query("SELECT data_type FROM information_schema.columns WHERE table_name = 'fixtures' AND column_name = 'match_date'");
    assert.equal(column.rows[0].data_type, 'timestamp with time zone');
  });
});

test('running every migration a second time changes nothing and does not fail', async () => {
  await withTempDatabase(async (pool) => {
    await applySchema(pool);
    const count = async () => (await pool.query('SELECT (SELECT count(*) FROM roles)::int AS roles, (SELECT count(*) FROM sports)::int AS sports')).rows[0];
    const first = await count();
    for (const file of migrationFiles()) {
      const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'db', 'migrations', file), 'utf8');
      await pool.query(sql);
    }
    assert.deepEqual(await count(), first);
  });
});

test('existing users are kept and moved to the roles table when the roles migration runs', async () => {
  await withTempDatabase(async (pool) => {
    const fs = require('fs');
    const path = require('path');
    const sql = (f) => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8');

    // An older database: users have the old text "role" column. Apply only the early files.
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    await pool.query(sql('001_auth_foundation.sql'));
    await pool.query("INSERT INTO users (email, password, role) VALUES ('old@example.com', 'x', 'user'), ('oldcoach@example.com', 'x', 'coach')");

    await pool.query(sql('002_roles_and_signup_profile.sql'));

    const { rows } = await pool.query('SELECT u.email, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.email');
    assert.deepEqual(rows, [
      { email: 'old@example.com', role: 'learner' },
      { email: 'oldcoach@example.com', role: 'coach' },
    ]);
    const oldColumn = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role'");
    assert.equal(oldColumn.rows.length, 0, 'the old users.role column is gone');
  });
});
