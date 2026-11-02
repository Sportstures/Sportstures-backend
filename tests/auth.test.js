const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, learnerPayload, coachPayload, signUpCoach, signUpLearner } = require('./helpers/setup');

let t;
before(async () => { t = await startTestApp(); });
after(async () => { await t.stop(); });

test('learner signup requires email verification before login', async () => {
  const payload = learnerPayload({ email: 'verify@example.com' });

  const registered = await t.api('POST', '/api/auth/register', payload);
  assert.equal(registered.status, 201);
  assert.ok(registered.body.userId);

  const early = await t.api('POST', '/api/auth/login', { email: payload.email, password: payload.password });
  assert.equal(early.status, 403);
  assert.equal(early.body.error.code, 'EMAIL_NOT_VERIFIED');

  const wrong = await t.api('POST', '/api/auth/verify-otp', { email: payload.email, code: '000000' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'INVALID_OTP');

  const verified = await t.api('POST', '/api/auth/verify-otp', { email: payload.email, code: t.lastCode(payload.email) });
  assert.equal(verified.status, 200);

  const login = await t.api('POST', '/api/auth/login', { email: payload.email, password: payload.password });
  assert.equal(login.status, 200);
  assert.ok(login.body.accessToken && login.body.refreshToken);
  assert.equal(login.body.user.role, 'learner');
  assert.equal('password' in login.body.user, false, 'password hash must never be returned');
});

test('learner profile (school, grade, sport, team) is saved and returned by /me', async () => {
  const learner = await signUpLearner(t, learnerPayload({ email: 'profile@example.com' }));
  const me = await t.api('GET', '/api/auth/me', undefined, learner.token);
  assert.equal(me.status, 200);
  const p = me.body.user.profile;
  assert.equal(p.school.name, 'Jeppe High');
  assert.equal(p.grade, 9);
  assert.equal(p.className, '9B');
  assert.equal(p.sport.name, 'Netball');
  assert.equal(p.teamName, 'Jeppe U15');
  assert.equal(p.jerseyNumber, 7);
  assert.equal(me.body.user.date_of_birth, '2009-05-14');
});

test('learner can skip the sport step', async () => {
  const learner = await signUpLearner(t, learnerPayload({ email: 'nosport@example.com', sport: null }));
  const me = await t.api('GET', '/api/auth/me', undefined, learner.token);
  assert.equal(me.body.user.profile.sport, null);
});

test("'Soccer' is stored as Football, and schools match ignoring case", async () => {
  await signUpLearner(t, learnerPayload({ email: 'soccer@example.com', sport: { name: 'Soccer' }, school: { name: 'JEPPE HIGH', grade: 8, className: '8A' } }));
  const schools = await t.pool.query("SELECT count(*)::int n FROM schools WHERE lower(name) = 'jeppe high'");
  assert.equal(schools.rows[0].n, 1);
  const sports = await t.pool.query("SELECT count(*)::int n FROM sports WHERE lower(name) IN ('soccer', 'football')");
  assert.equal(sports.rows[0].n, 1);
  const named = await t.pool.query("SELECT 1 FROM sports WHERE name = 'Football'");
  assert.equal(named.rows.length, 1);
});

test('duplicate email gives 409, even with different capitals', async () => {
  await signUpLearner(t, learnerPayload({ email: 'dupe@example.com' }));
  const again = await t.api('POST', '/api/auth/register', learnerPayload({ email: 'DUPE@example.com' }));
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'EMAIL_TAKEN');
});

test('a failed signup leaves nothing behind (rolled back)', async () => {
  const before = await t.pool.query('SELECT count(*)::int n FROM users');
  const bad = await t.api('POST', '/api/auth/register', learnerPayload({ email: 'bad@example.com', school: { name: 'X', grade: 13, className: '1' } }));
  assert.equal(bad.status, 400);
  const after = await t.pool.query('SELECT count(*)::int n FROM users');
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test('REGRESSION: signup with no role returns 400 instead of crashing the server', async () => {
  const noRole = await t.api('POST', '/api/auth/register', { email: 'norole@example.com', password: 'Passw0rdOK' });
  assert.equal(noRole.status, 400);
  assert.equal(noRole.body.error.code, 'ROLE_REQUIRED');
  const health = await t.api('GET', '/health');
  assert.equal(health.status, 200, 'server must still be running');
});

test('nobody can register as admin or coach through /register', async () => {
  for (const role of ['admin', 'coach']) {
    const res = await t.api('POST', '/api/auth/register', learnerPayload({ email: `${role}@example.com`, role }));
    assert.equal(res.status, 400, `role ${role} must be rejected`);
  }
  const rows = await t.pool.query("SELECT count(*)::int n FROM users WHERE email IN ('admin@example.com', 'coach@example.com')");
  assert.equal(rows.rows[0].n, 0);
});

test('validation: weak password, bad date of birth, bad gender, bad jersey number', async () => {
  const cases = [
    [{ password: 'short' }, 'password'],
    [{ password: 'allletters' }, 'password'],
    [{ dateOfBirth: '14/05/2009' }, 'dateOfBirth'],
    [{ dateOfBirth: '2999-01-01' }, 'dateOfBirth'],
    [{ gender: 'robot' }, 'gender'],
    [{ sport: { name: 'Netball', jerseyNumber: 5000 } }, 'sport.jerseyNumber'],
    [{ email: 'not-an-email' }, 'email'],
  ];
  for (const [override, field] of cases) {
    const res = await t.api('POST', '/api/auth/register', learnerPayload({ email: 'v@example.com', ...override }));
    assert.equal(res.status, 400, `expected 400 for ${field}`);
    assert.ok(res.body.error.details.some((d) => d.field === field), `expected an error on ${field}: ${JSON.stringify(res.body)}`);
  }
});

test('five wrong verification codes lock the code until a new one is requested', async () => {
  const payload = learnerPayload({ email: 'lock@example.com' });
  await t.api('POST', '/api/auth/register', payload);
  const real = t.lastCode(payload.email);
  let last;
  for (let i = 0; i < 5; i++) last = await t.api('POST', '/api/auth/verify-otp', { email: payload.email, code: real === '111111' ? '222222' : '111111' });
  assert.equal(last.status, 429);
  const correct = await t.api('POST', '/api/auth/verify-otp', { email: payload.email, code: real });
  assert.equal(correct.status, 429, 'even the right code is refused after too many wrong ones');
});

test('resend has a cooldown, then issues a fresh working code', async () => {
  const payload = learnerPayload({ email: 'resend@example.com' });
  await t.api('POST', '/api/auth/register', payload);
  const tooSoon = await t.api('POST', '/api/auth/resend-otp', { email: payload.email });
  assert.equal(tooSoon.status, 429);

  await t.pool.query("UPDATE email_verification_codes SET resend_after = NOW() - INTERVAL '1 second' WHERE user_id = (SELECT id FROM users WHERE email = $1)", [payload.email]);
  const resent = await t.api('POST', '/api/auth/resend-otp', { email: payload.email });
  assert.equal(resent.status, 200);
  assert.equal(resent.body.retryAfterSeconds, 60);

  const verified = await t.api('POST', '/api/auth/verify-otp', { email: payload.email, code: t.lastCode(payload.email) });
  assert.equal(verified.status, 200);
});

test('resend for an unknown email reveals nothing', async () => {
  const res = await t.api('POST', '/api/auth/resend-otp', { email: 'nobody-here@example.com' });
  assert.equal(res.status, 200);
  assert.equal(res.body.retryAfterSeconds, 0);
});

test('login: wrong password and unknown email give the same error', async () => {
  const learner = await signUpLearner(t, learnerPayload({ email: 'login@example.com' }));
  const wrong = await t.api('POST', '/api/auth/login', { email: learner.email, password: 'wrongpass1' });
  const unknown = await t.api('POST', '/api/auth/login', { email: 'ghost@example.com', password: 'wrongpass1' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.body.error.message, unknown.body.error.message);
});

test('/me needs a token', async () => {
  const res = await t.api('GET', '/api/auth/me');
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'NO_TOKEN');
  const bad = await t.api('GET', '/api/auth/me', undefined, 'garbage');
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.code, 'INVALID_TOKEN');
});

test('refresh tokens rotate, and reusing an old one revokes the whole family', async () => {
  const learner = await signUpLearner(t, learnerPayload({ email: 'refresh@example.com' }));
  const first = await t.api('POST', '/api/auth/refresh', { refreshToken: learner.refreshToken });
  assert.equal(first.status, 200);
  assert.notEqual(first.body.refreshToken, learner.refreshToken);

  const reused = await t.api('POST', '/api/auth/refresh', { refreshToken: learner.refreshToken });
  assert.equal(reused.status, 401);
  const newOneNowDead = await t.api('POST', '/api/auth/refresh', { refreshToken: first.body.refreshToken });
  assert.equal(newOneNowDead.status, 401, 'reuse must revoke the newer token too');
});

test('logout revokes the refresh token', async () => {
  const learner = await signUpLearner(t, learnerPayload({ email: 'logout@example.com' }));
  assert.equal((await t.api('POST', '/api/auth/logout', { refreshToken: learner.refreshToken })).status, 200);
  assert.equal((await t.api('POST', '/api/auth/refresh', { refreshToken: learner.refreshToken })).status, 401);
});

test('coach signup creates the coach, their team and logs them in after verification', async () => {
  const payload = coachPayload({ email: 'coach1@example.com' });
  const registered = await t.api('POST', '/api/auth/register/coach', payload);
  assert.equal(registered.status, 201);
  assert.equal(registered.body.status, 'pending_verification');

  const early = await t.api('POST', '/api/auth/login', { email: payload.email, password: payload.password });
  assert.equal(early.status, 403);

  const verified = await t.api('POST', '/api/auth/verify-otp', { email: payload.email, code: t.lastCode(payload.email) });
  assert.equal(verified.status, 200);
  assert.ok(verified.body.accessToken, 'verified coaches are logged in straight away');
  assert.equal(verified.body.user.role, 'coach');
  assert.equal(verified.body.user.team.name, 'Basketball Boys');
  assert.equal(verified.body.user.team.sport.name, 'Basketball');
  assert.equal(verified.body.user.profile.coachingRole, 'head_coach');
  assert.equal(verified.body.user.profile.school.name, 'Jeppe High');

  const teams = await t.api('GET', '/api/teams?mine=true', undefined, verified.body.accessToken);
  assert.deepEqual(teams.body.teams.map((x) => x.name), ['Basketball Boys']);
});

test('coach signup rejects values the dropdowns should not send', async () => {
  const bad = await t.api('POST', '/api/auth/register/coach', coachPayload({ email: 'c2@example.com', coachingRole: 'Head Coach' }));
  assert.equal(bad.status, 422);
  assert.ok(bad.body.errors.coachingRole);
  const badLevel = await t.api('POST', '/api/auth/register/coach', coachPayload({ email: 'c3@example.com', team: { name: 'T', level: '1st Team', sport: 'Basketball' } }));
  assert.equal(badLevel.status, 422);
  assert.ok(badLevel.body.errors['team.level']);
});

test('GET /api/sports lists the sports and /api/contact lists the contact addresses', async () => {
  const sports = await t.api('GET', '/api/sports');
  assert.equal(sports.status, 200);
  const names = sports.body.sports.map((s) => s.name);
  for (const expected of ['Athletics', 'Basketball', 'Football', 'Netball', 'Swimming']) assert.ok(names.includes(expected), expected);
  const contact = await t.api('GET', '/api/contact');
  assert.equal(contact.status, 200);
  assert.ok(contact.body.contacts);
});

test('signUpCoach helper really produces a verified coach (guards the other test files)', async () => {
  const coach = await signUpCoach(t, { email: 'helper@example.com' });
  assert.equal(coach.user.role, 'coach');
});
