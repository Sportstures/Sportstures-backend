// Shared test setup. Each test file calls startTestApp() once.
//
// It creates a throwaway PostgreSQL database (never touches your real one), applies
// db/schema.sql and every migration like a fresh install, starts the real Express app on a
// random port, and replaces email sending so tests can read the verification codes.
//
// Needs DB_USER, DB_PASSWORD, DB_HOST and DB_PORT in .env (the same ones the app uses).
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(root, '.env') });

// Settings for tests. These must be set before the app is loaded.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-not-for-real-use';
process.env.AUTH_RATE_LIMIT_MAX = '10000';
process.env.OTP_RATE_LIMIT_MAX = '10000';
delete process.env.SMTP_HOST;
delete process.env.SMTP_FROM;

const { Client, Pool } = require('pg');

const connection = {
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
};

function readSql(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function migrationFiles() {
  return fs.readdirSync(path.join(root, 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
}

// Applies schema.sql and every migration, in file-name order, to a pool.
async function applySchema(pool) {
  await pool.query(readSql('db/schema.sql'));
  for (const file of migrationFiles()) {
    await pool.query(readSql(`db/migrations/${file}`));
  }
}

async function startTestApp() {
  const dbName = `sportstures_test_${process.pid}_${Date.now()}`;
  const admin = new Client({ ...connection, database: 'postgres' });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);

  // The app reads DB_NAME when db/config.js loads, so point it at the throwaway database first.
  process.env.DB_NAME = dbName;
  const setupPool = new Pool({ ...connection, database: dbName });
  await applySchema(setupPool);

  // Capture verification codes instead of sending email.
  const sentEmails = [];
  const emailModule = require.resolve(path.join(root, 'src/utils/email.js'));
  require.cache[emailModule] = {
    id: emailModule,
    filename: emailModule,
    loaded: true,
    exports: {
      sendEmail: async () => {},
      sendVerificationCode: async (to, otp) => { sentEmails.push({ to, otp }); },
    },
  };

  const app = require(path.join(root, 'src/server.js'));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const origin = `http://localhost:${server.address().port}`;

  async function api(method, url, body, token) {
    const res = await fetch(origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A request that never answers (for example a crashed handler) should fail the test, not hang it.
      signal: AbortSignal.timeout(15000),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: data };
  }

  // The most recent verification code sent to an email address.
  function lastCode(email) {
    const found = [...sentEmails].reverse().find((m) => m.to === email.toLowerCase());
    return found ? found.otp : null;
  }

  async function stop() {
    server.close();
    // Close the app's own pool, then the setup pool, then drop the database.
    await require(path.join(root, 'db/config.js')).end();
    await setupPool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  }

  return { api, pool: setupPool, lastCode, sentEmails, stop };
}

// Test data builders matching the mobile signup screens.
function learnerPayload(overrides = {}) {
  return {
    email: 'ada@example.com',
    password: 'Passw0rdOK',
    role: 'learner',
    firstName: 'Ada',
    lastName: 'Obi',
    dateOfBirth: '2009-05-14',
    gender: 'female',
    school: { name: 'Jeppe High', grade: 9, className: '9B' },
    sport: { name: 'Netball', teamName: 'Jeppe U15', jerseyNumber: 7, level: 'U15' },
    ...overrides,
  };
}

function coachPayload(overrides = {}) {
  return {
    email: 'coach@example.com',
    password: 'Passw0rdOK',
    firstName: 'Sipho',
    lastName: 'Williams',
    dateOfBirth: '1985-03-02',
    gender: 'male',
    school: 'Jeppe High',
    coachingRole: 'head_coach',
    experience: '5_10_years',
    team: { name: 'Basketball Boys', level: '1st_team', sport: 'Basketball' },
    ...overrides,
  };
}

// Registers and verifies a coach, returning { token, user, team }.
async function signUpCoach(t, overrides = {}) {
  const payload = coachPayload(overrides);
  const registered = await t.api('POST', '/api/auth/register/coach', payload);
  if (registered.status !== 201) throw new Error(`coach signup failed: ${JSON.stringify(registered.body)}`);
  const verified = await t.api('POST', '/api/auth/verify-otp', { email: payload.email, code: t.lastCode(payload.email) });
  if (verified.status !== 200) throw new Error(`coach verify failed: ${JSON.stringify(verified.body)}`);
  return { token: verified.body.accessToken, user: verified.body.user, email: payload.email };
}

// Registers, verifies and logs in a learner, returning { token, user, refreshToken }.
async function signUpLearner(t, overrides = {}) {
  const payload = learnerPayload(overrides);
  const registered = await t.api('POST', '/api/auth/register', payload);
  if (registered.status !== 201) throw new Error(`learner signup failed: ${JSON.stringify(registered.body)}`);
  await t.api('POST', '/api/auth/verify-otp', { email: payload.email, code: t.lastCode(payload.email) });
  const login = await t.api('POST', '/api/auth/login', { email: payload.email, password: payload.password });
  if (login.status !== 200) throw new Error(`learner login failed: ${JSON.stringify(login.body)}`);
  return { token: login.body.accessToken, refreshToken: login.body.refreshToken, user: login.body.user, email: payload.email };
}

// Makes an existing user an admin (admins can only be created directly in the database).
async function makeAdmin(t, email) {
  await t.pool.query(
    "UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'admin') WHERE email = $1",
    [email]
  );
}

module.exports = {
  startTestApp, applySchema, migrationFiles, connection,
  learnerPayload, coachPayload, signUpCoach, signUpLearner, makeAdmin,
};
