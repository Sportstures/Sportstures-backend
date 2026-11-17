// Help & Support messages: POST /api/support/messages (emails are captured by the fake in setup.js).
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

const send = (body, token) => t.api('POST', '/api/support/messages', body, token);
const valid = (overrides = {}) => ({
  topic: 'matches',
  subject: "Can't see my team's matches",
  message: 'I joined Northview U16 netball last week but no matches show on Home.',
  ...overrides,
});
const lastOf = (kind) => [...t.supportEmails].reverse().find((e) => e.kind === kind);

test('a signed-in learner sends a message; the account email, name and school are used', async () => {
  const learner = await signUpLearner(t, { email: 'helpme@example.com' });
  const res = await send(valid({ email: 'ignored@example.com', name: 'Ignored', app: { platform: 'android', version: '1.0.0' } }), learner.token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.replyTo, 'helpme@example.com');
  assert.equal(res.body.message, "Thanks. We'll reply to helpme@example.com.");
  assert.ok(Number.isInteger(res.body.id));

  const emailed = lastOf('message');
  assert.equal(emailed.id, res.body.id);
  assert.equal(emailed.email, 'helpme@example.com');
  assert.equal(emailed.name, 'Ada Obi');
  assert.deepEqual(emailed.user, { id: learner.user.id, role: 'learner', school: 'Jeppe High' });
  assert.deepEqual(emailed.app, { platform: 'android', version: '1.0.0' });
  assert.equal(lastOf('receipt').id, res.body.id, 'the sender gets a receipt');

  const { rows: [row] } = await t.pool.query('SELECT * FROM support_messages WHERE id = $1', [res.body.id]);
  assert.equal(row.user_id, learner.user.id);
  assert.equal(row.topic, 'matches');
  assert.ok(row.emailed_at, 'marked as emailed');
});

test('a coach gets their coaching school attached', async () => {
  const coach = await signUpCoach(t, { email: 'coachhelp@example.com' });
  const res = await send(valid({ topic: 'teams', subject: '' }), coach.token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const emailed = lastOf('message');
  assert.equal(emailed.user.role, 'coach');
  assert.equal(emailed.user.school, 'Jeppe High');
  assert.equal(emailed.subject, 'Help with teams', 'a missing subject is built from the topic');
});

test('signed out, the reply email is required and used', async () => {
  const missing = await send(valid());
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body.error.details.map((d) => d.field), ['email']);

  const res = await send(valid({ email: ' Visitor@Example.com ', name: 'Visitor\nBcc: evil@example.com' }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.replyTo, 'visitor@example.com');
  const emailed = lastOf('message');
  assert.equal(emailed.user, null);
  assert.equal(emailed.name, 'Visitor Bcc: evil@example.com', 'line breaks are removed from header fields');
});

test('invalid messages are refused with a detail per field', async () => {
  const learner = await signUpLearner(t, { email: 'badinput@example.com' });
  const res = await send({
    topic: 'billing', subject: 'x'.repeat(151), message: 'too short', app: { platform: 'symbian', version: 'x'.repeat(21) },
  }, learner.token);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(
    res.body.error.details.map((d) => d.field).sort(),
    ['app.platform', 'app.version', 'message', 'subject', 'topic']
  );
  assert.equal((await send(valid({ message: 'x'.repeat(5001) }), learner.token)).status, 400);
  assert.equal((await send(valid({ app: { platform: 'web' } }), learner.token)).status, 201, 'the web app is accepted too');
});

test('an expired or invalid token is refused rather than treated as signed out', async () => {
  const res = await send(valid({ email: 'x@example.com' }), 'not-a-token');
  assert.equal(res.status, 401);
});

test('5 accepted messages an hour per user, then 429 with Retry-After; rejected ones do not count', async () => {
  const learner = await signUpLearner(t, { email: 'spammy@example.com' });
  for (let i = 0; i < 3; i += 1) assert.equal((await send(valid({ topic: 'nope' }), learner.token)).status, 400);
  for (let i = 0; i < 5; i += 1) assert.equal((await send(valid(), learner.token)).status, 201, `message ${i + 1}`);

  const res = await fetch(`${t.origin}/api/support/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${learner.token}` },
    body: JSON.stringify(valid()),
  });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  assert.equal((await res.json()).error.code, 'TOO_MANY_REQUESTS');

  const other = await signUpLearner(t, { email: 'notspammy@example.com' });
  assert.equal((await send(valid(), other.token)).status, 201, 'other users are not affected');
});

test('503 when email is not set up', async () => {
  const learner = await signUpLearner(t, { email: 'nomail@example.com' });
  t.mail.enabled = false;
  try {
    const res = await send(valid(), learner.token);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'SUPPORT_UNAVAILABLE');
  } finally {
    t.mail.enabled = true;
  }
});

test('if the support email fails, the message is still saved and accepted', async () => {
  const learner = await signUpLearner(t, { email: 'smtpdown@example.com' });
  t.mail.failSupport = true;
  try {
    const res = await send(valid(), learner.token);
    assert.equal(res.status, 201);
    const { rows: [row] } = await t.pool.query('SELECT emailed_at FROM support_messages WHERE id = $1', [res.body.id]);
    assert.equal(row.emailed_at, null, 'left for support to find');
  } finally {
    t.mail.failSupport = false;
  }
});
