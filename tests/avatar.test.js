// Profile photo upload: PUT and DELETE /api/me/avatar (Cloudinary is replaced by a fake in setup.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpLearner } = require('./helpers/setup');

let t;
let learner;

before(async () => {
  t = await startTestApp();
  learner = await signUpLearner(t);
});

after(async () => {
  await t.stop();
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

// Sends a multipart upload the way the apps do. The type defaults to octet-stream, as Flutter's http sends.
async function upload(bytes, { token = learner.token, field = 'photo', type = 'application/octet-stream' } = {}) {
  const form = new FormData();
  if (bytes) form.append(field, new Blob([bytes], { type }), 'photo.png');
  const res = await fetch(`${t.origin}/api/me/avatar`, {
    method: 'PUT',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, body: await res.json() };
}

test('a new user has no photo', async () => {
  const me = await t.api('GET', '/api/auth/me', undefined, learner.token);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.avatarUrl, null);
});

test('upload needs a login', async () => {
  const res = await upload(PNG, { token: null });
  assert.equal(res.status, 401);
});

test('a learner uploads a photo and it shows on their profile', async () => {
  const res = await upload(PNG);
  assert.equal(res.status, 200);
  assert.match(res.body.avatarUrl, /^https:\/\/res\.cloudinary\.com\/.+user_\d+\.jpg$/);
  assert.equal(t.uploads.at(-1).userId, learner.user.id);

  const me = await t.api('GET', '/api/auth/me', undefined, learner.token);
  assert.equal(me.body.user.avatarUrl, res.body.avatarUrl);
});

test('a second upload replaces the first', async () => {
  const res = await upload(PNG);
  assert.equal(res.status, 200);
  const me = await t.api('GET', '/api/auth/me', undefined, learner.token);
  assert.equal(me.body.user.avatarUrl, res.body.avatarUrl);
});

test('rejects files that are not images, even when labelled as one', async () => {
  const res = await upload(Buffer.from('this is not really an image at all'), { type: 'image/png' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'INVALID_IMAGE');
});

test('rejects a request with no photo field', async () => {
  const missing = await upload(null);
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'NO_FILE');

  const wrongField = await upload(PNG, { field: 'image' });
  assert.equal(wrongField.status, 400);
  assert.equal(wrongField.body.error.code, 'INVALID_UPLOAD');
});

test('rejects photos over 5 MB', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
  const res = await upload(big);
  assert.equal(res.status, 413);
  assert.equal(res.body.error.code, 'FILE_TOO_LARGE');
});

test('a learner removes their photo', async () => {
  const res = await t.api('DELETE', '/api/me/avatar', undefined, learner.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.avatarUrl, null);
  assert.equal(t.deleted.at(-1), `sportstures/avatars/user_${learner.user.id}`);

  const me = await t.api('GET', '/api/auth/me', undefined, learner.token);
  assert.equal(me.body.user.avatarUrl, null);
});
