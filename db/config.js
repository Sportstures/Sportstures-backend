const { Pool } = require('pg');
require('dotenv').config();

// Two ways to connect:
// - DATABASE_URL: one connection string, as hosts such as Render give it
//   (postgresql://user:password@host:5432/dbname).
// - DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME: separate settings, for a local database.
//
// SSL: Render's External Database URL (a *.render.com host) needs SSL, so it is switched on for
// those automatically. DB_SSL=true or DB_SSL=false overrides that. Render's Internal Database URL
// (used by a web service running on Render) works without it.
function sslSetting(host) {
  if (process.env.DB_SSL === 'true') return { rejectUnauthorized: false };
  if (process.env.DB_SSL === 'false') return false;
  return /\.render\.com$/i.test(host || '') ? { rejectUnauthorized: false } : false;
}

function connectionSettings() {
  if (process.env.DATABASE_URL) {
    const { hostname } = new URL(process.env.DATABASE_URL);
    return { connectionString: process.env.DATABASE_URL, ssl: sslSetting(hostname) };
  }
  const host = process.env.DB_HOST || 'localhost';
  return {
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    host,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'sportstures',
    ssl: sslSetting(host),
  };
}

const pool = new Pool(connectionSettings());

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

module.exports = pool;
