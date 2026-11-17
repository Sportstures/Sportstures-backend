// Changing an account after signup: PATCH /api/me/profile, PUT /api/me/password, POST /api/me/email(+/verify),
// and POST /api/auth/forgot-password + /reset-password.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpLearner, signUpCoach } = require('./helpers/setup');

let t;

before(async () => {
  t = await startTestApp();
});

after(async () => {
  await t.stop();
});

const patch = (body, token) => t.api('PATCH', '/api/me/profile', body, token);
const login = (email, password) => t.api('POST', '/api/auth/login', { email, password });
const codeFor = (email, purpose) => {
  const found = [...t.sentEmails].reverse().find((m) => m.to === email && m.purpose === purpose);
  return found ? found.otp : null;
};
const wrongCode = (code) => (code === '000000' ? '111111' : '000000');

// ---- Profile ---------------------------------------------------------------------------------

test('a learner changes their personal details', async () => {
  const { token } = await signUpLearner(t, { email: 'personal@example.com' });
  const res = await patch({
    firstName: '  Adaeze ', lastName: 'Okafor', phone: '+27 82 555 0101', dateOfBirth: '2008-01-31', gender: 'female',
  }, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const u = res.body.user;
  assert.equal(u.firstName, 'Adaeze');
  assert.equal(u.lastName, 'Okafor');
  assert.equal(u.phone, '+27 82 555 0101');
  assert.equal(u.dateOfBirth, '2008-01-31');

  const me = await t.api('GET', '/api/auth/me', undefined, token);
  assert.equal(me.body.user.firstName, 'Adaeze');
  assert.equal(me.body.user.profile.school.name, 'Jeppe High', 'school is untouched');

  const cleared = await patch({ phone: '' }, token);
  assert.equal(cleared.body.user.phone, null);
});

test('a learner changes school, grade and class', async () => {
  const { token } = await signUpLearner(t, { email: 'mover@example.com' });
  const res = await patch({ school: { name: 'Northview High', province: 'Limpopo', town: 'Polokwane', grade: 10, className: '10C' } }, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const p = res.body.user.profile;
  assert.equal(p.school.name, 'Northview High');
  assert.equal(p.grade, 10);
  assert.equal(p.className, '10C');

  const { rows: [school] } = await t.pool.query("SELECT province, town FROM schools WHERE name = 'Northview High'");
  assert.deepEqual(school, { province: 'Limpopo', town: 'Polokwane' });

  const gradeOnly = await patch({ school: { grade: 11 } }, token);
  assert.equal(gradeOnly.body.user.profile.grade, 11);
  assert.equal(gradeOnly.body.user.profile.school.name, 'Northview High');
});

test('a learner changes, then removes, then re-adds their sport', async () => {
  const { token } = await signUpLearner(t, { email: 'sporty@example.com' });
  const changed = await patch({ sport: { name: 'Soccer', teamName: 'Jeppe U16', jerseyNumber: 10, level: 'U16' } }, token);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.user.profile.sport.name, 'Football');
  assert.equal(changed.body.user.profile.teamName, 'Jeppe U16');
  assert.equal(changed.body.user.profile.jerseyNumber, 10);

  const jerseyOnly = await patch({ sport: { jerseyNumber: 4 } }, token);
  assert.equal(jerseyOnly.body.user.profile.jerseyNumber, 4);
  assert.equal(jerseyOnly.body.user.profile.sport.name, 'Football');

  const removed = await patch({ sport: null }, token);
  const p = removed.body.user.profile;
  assert.deepEqual([p.sport, p.teamName, p.jerseyNumber, p.level], [null, null, null, null]);

  // With no sport, a team detail alone is refused, and nothing else in the request is saved.
  const noName = await patch({ firstName: 'Changed', sport: { jerseyNumber: 9 } }, token);
  assert.equal(noName.status, 400);
  assert.equal(noName.body.error.code, 'SPORT_REQUIRED');
  const me = await t.api('GET', '/api/auth/me', undefined, token);
  assert.equal(me.body.user.firstName, 'Ada', 'the whole request was rolled back');

  const readded = await patch({ sport: { name: 'Netball', jerseyNumber: 9 } }, token);
  assert.equal(readded.body.user.profile.sport.name, 'Netball');
});

test('invalid profile values are refused', async () => {
  const { token } = await signUpLearner(t, { email: 'invalid@example.com' });
  const cases = [
    { firstName: '   ' },
    { gender: 'other' },
    { dateOfBirth: '2999-01-01' },
    { dateOfBirth: '2009-02-30' },
    { phone: 'call me' },
    { school: { grade: 13 } },
    { school: { className: '' } },
    { school: { province: 'Gauteng' } },
    { school: { name: 'X', province: 'Atlantis' } },
    { sport: { jerseyNumber: 1000 } },
    { sport: 'Netball' },
  ];
  for (const body of cases) {
    const res = await patch(body, token);
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR', JSON.stringify(body));
  }
});

test('profile edit needs a change, a login, and points email/password to their own endpoints', async () => {
  const { token } = await signUpLearner(t, { email: 'pointers@example.com' });
  assert.equal((await patch({}, token)).body.error.code, 'NOTHING_TO_UPDATE');
  assert.equal((await patch({ email: 'x@example.com' }, token)).body.error.code, 'USE_EMAIL_ENDPOINT');
  assert.equal((await patch({ password: 'Passw0rdNEW' }, token)).body.error.code, 'USE_PASSWORD_ENDPOINT');
  assert.equal((await patch({ firstName: 'X' })).status, 401);
});

test('a coach can change personal details but not learner school or sport', async () => {
  const { token } = await signUpCoach(t, { email: 'coach-edit@example.com' });
  const ok = await patch({ firstName: 'Themba' }, token);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.firstName, 'Themba');
  const refused = await patch({ school: { grade: 10 } }, token);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'LEARNER_ONLY');
});

// ---- Change password -------------------------------------------------------------------------

test('a learner changes their password and other sessions are signed out', async () => {
  const learner = await signUpLearner(t, { email: 'changepw@example.com' });
  const put = (body) => t.api('PUT', '/api/me/password', body, learner.token);

  const wrong = await put({ currentPassword: 'nope12345', newPassword: 'NewPassw0rd' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'WRONG_PASSWORD');

  const weak = await put({ currentPassword: 'Passw0rdOK', newPassword: 'short' });
  assert.equal(weak.body.error.code, 'VALIDATION_ERROR');

  const same = await put({ currentPassword: 'Passw0rdOK', newPassword: 'Passw0rdOK' });
  assert.equal(same.body.error.code, 'SAME_PASSWORD');

  const res = await put({ currentPassword: 'Passw0rdOK', newPassword: 'NewPassw0rd' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.accessToken && res.body.refreshToken);

  const newRefresh = await t.api('POST', '/api/auth/refresh', { refreshToken: res.body.refreshToken });
  assert.equal(newRefresh.status, 200, 'the new tokens work');
  // (Checked second: reusing a revoked token is treated as theft and revokes every session.)
  const oldRefresh = await t.api('POST', '/api/auth/refresh', { refreshToken: learner.refreshToken });
  assert.equal(oldRefresh.status, 401, 'the old session is revoked');

  assert.equal((await login('changepw@example.com', 'Passw0rdOK')).status, 401);
  assert.equal((await login('changepw@example.com', 'NewPassw0rd')).status, 200);
  assert.equal(t.notices.at(-1).kind, 'password_changed');
  assert.equal(t.notices.at(-1).to, 'changepw@example.com');
});

// ---- Forgot / reset password -----------------------------------------------------------------

test('forgot password answers the same for unknown emails and sends nothing', async () => {
  const before = t.sentEmails.length;
  const res = await t.api('POST', '/api/auth/forgot-password', { email: 'nobody@example.com' });
  assert.equal(res.status, 200);
  assert.match(res.body.message, /If an account exists/);
  assert.equal(t.sentEmails.length, before);
});

test('a learner resets a forgotten password with the emailed code', async () => {
  const learner = await signUpLearner(t, { email: 'forgot@example.com' });
  const asked = await t.api('POST', '/api/auth/forgot-password', { email: 'Forgot@Example.com' });
  assert.equal(asked.status, 200);
  const code = codeFor('forgot@example.com', 'password_reset');
  assert.match(code, /^\d{6}$/);

  const reset = (body) => t.api('POST', '/api/auth/reset-password', { email: 'forgot@example.com', ...body });
  const bad = await reset({ code: wrongCode(code), newPassword: 'Fresh1234' });
  assert.equal(bad.body.error.code, 'INVALID_OTP');
  const weak = await reset({ code, newPassword: 'weak' });
  assert.equal(weak.body.error.code, 'VALIDATION_ERROR');

  const ok = await reset({ code, newPassword: 'Fresh1234' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await reset({ code, newPassword: 'Again1234' })).body.error.code, 'INVALID_OTP', 'a code works once');

  assert.equal((await login('forgot@example.com', 'Fresh1234')).status, 200);
  assert.equal((await login('forgot@example.com', 'Passw0rdOK')).status, 401);
  assert.equal((await t.api('POST', '/api/auth/refresh', { refreshToken: learner.refreshToken })).status, 401);
});

test('forgot password has a resend cooldown and locks after five wrong codes', async () => {
  await signUpLearner(t, { email: 'locked@example.com' });
  await t.api('POST', '/api/auth/forgot-password', { email: 'locked@example.com' });
  const first = codeFor('locked@example.com', 'password_reset');
  await t.api('POST', '/api/auth/forgot-password', { email: 'locked@example.com' });
  assert.equal(codeFor('locked@example.com', 'password_reset'), first, 'no new code during the cooldown');

  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await t.api('POST', '/api/auth/reset-password', { email: 'locked@example.com', code: wrongCode(first), newPassword: 'Fresh1234' });
  }
  assert.equal(last.status, 429);
  const right = await t.api('POST', '/api/auth/reset-password', { email: 'locked@example.com', code: first, newPassword: 'Fresh1234' });
  assert.equal(right.status, 429, 'even the right code is refused once locked');
});

test('resetting the password also verifies an unverified signup', async () => {
  await t.api('POST', '/api/auth/register', {
    email: 'unverified@example.com', password: 'Passw0rdOK', role: 'learner', firstName: 'U', lastName: 'V',
    dateOfBirth: '2009-05-14', gender: 'male', school: { name: 'Jeppe High', grade: 9, className: '9B' },
  });
  await t.api('POST', '/api/auth/forgot-password', { email: 'unverified@example.com' });
  const code = codeFor('unverified@example.com', 'password_reset');
  await t.api('POST', '/api/auth/reset-password', { email: 'unverified@example.com', code, newPassword: 'Fresh1234' });
  assert.equal((await login('unverified@example.com', 'Fresh1234')).status, 200);
});

// ---- Change email ----------------------------------------------------------------------------

test('a learner changes their email after confirming a code sent to the new address', async () => {
  const learner = await signUpLearner(t, { email: 'old@example.com' });
  await signUpLearner(t, { email: 'taken@example.com' });
  const ask = (body) => t.api('POST', '/api/me/email', body, learner.token);

  assert.equal((await ask({ newEmail: 'new@example.com', password: 'wrong123' })).body.error.code, 'WRONG_PASSWORD');
  assert.equal((await ask({ newEmail: 'TAKEN@example.com', password: 'Passw0rdOK' })).status, 409);
  assert.equal((await ask({ newEmail: 'old@example.com', password: 'Passw0rdOK' })).body.error.code, 'SAME_EMAIL');
  assert.equal((await ask({ newEmail: 'not-an-email', password: 'Passw0rdOK' })).body.error.code, 'VALIDATION_ERROR');

  const asked = await ask({ newEmail: 'New@Example.com', password: 'Passw0rdOK' });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.email, 'new@example.com');
  const code = codeFor('new@example.com', 'email_change');
  assert.match(code, /^\d{6}$/);

  const again = await ask({ newEmail: 'new@example.com', password: 'Passw0rdOK' });
  assert.equal(again.status, 429, 'cooldown before another code');

  // Nothing changes until the code is confirmed.
  assert.equal((await t.api('GET', '/api/auth/me', undefined, learner.token)).body.user.email, 'old@example.com');

  const verify = (c) => t.api('POST', '/api/me/email/verify', { code: c }, learner.token);
  assert.equal((await verify(wrongCode(code))).body.error.code, 'INVALID_OTP');
  const ok = await verify(code);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.user.email, 'new@example.com');

  assert.equal((await login('new@example.com', 'Passw0rdOK')).status, 200);
  assert.equal((await login('old@example.com', 'Passw0rdOK')).status, 401);
  const notice = t.notices.at(-1);
  assert.deepEqual([notice.kind, notice.to, notice.newEmail], ['email_changed', 'old@example.com', 'new@example.com']);
});

test('confirming fails if someone else took the address in the meantime', async () => {
  const learner = await signUpLearner(t, { email: 'racer@example.com' });
  await t.api('POST', '/api/me/email', { newEmail: 'contested@example.com', password: 'Passw0rdOK' }, learner.token);
  const code = codeFor('contested@example.com', 'email_change');
  await signUpLearner(t, { email: 'contested@example.com' });
  const res = await t.api('POST', '/api/me/email/verify', { code }, learner.token);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'EMAIL_TAKEN');
});
