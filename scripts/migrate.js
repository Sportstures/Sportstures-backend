// Builds or updates the database: db/schema.sql, then every file in db/migrations in file-name order.
//
//   npm run db:migrate                        uses .env (DATABASE_URL, or DB_HOST/DB_USER/...)
//   DATABASE_URL="postgresql://..." npm run db:migrate    any other database, such as Render's
//
// Each migration that finishes is recorded in schema_migrations and skipped next time, so it is
// safe to run on every deploy. Each file runs in its own transaction: if one fails, nothing from
// that file is kept, it is not recorded, and the script stops with an error.
// All the SQL files are written to be safe to run again, so a database that was set up by hand in
// pgAdmin (with no schema_migrations table yet) can be brought up to date this way too.
const fs = require('fs');
const path = require('path');
const pool = require('../db/config');

const dbDir = path.join(__dirname, '..', 'db');

function migrationFiles() {
  return fs.readdirSync(path.join(dbDir, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
}

async function runFile(client, label, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    if (label) await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [label]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function migrate({ log = console.log } = {}) {
  const client = await pool.connect();
  try {
    const { rows: [where] } = await client.query('SELECT current_database() AS db, inet_server_addr() AS host');
    log(`Database: ${where.db}${where.host ? ` on ${where.host}` : ''}`);

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

    // The base tables. Every statement is IF NOT EXISTS, so this is always safe.
    await runFile(client, null, fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8'));

    const done = new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));
    const pending = migrationFiles().filter((f) => !done.has(f));
    for (const file of pending) {
      log(`Applying ${file}`);
      try {
        await runFile(client, file, fs.readFileSync(path.join(dbDir, 'migrations', file), 'utf8'));
      } catch (err) {
        err.message = `${file} failed: ${err.message}`;
        throw err;
      }
    }
    log(pending.length ? `Done: ${pending.length} migration(s) applied.` : 'Already up to date.');
    return pending;
  } finally {
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err.message);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
