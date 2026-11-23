// Team logos: PUT and DELETE /api/teams/:id/logo (Cloudinary is replaced by a fake in setup.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, makeAdmin } = require('./helpers/setup');

let t; let coach; let rival; let team; let rivalTeam;

before(async () => {
  t = await startTestApp();
  coach = await signUpCoach(t, { email: 'a@x.co.za', school: 'Alpha High', team: { name: 'Alpha Netball', level: '1st_team', sport: 'Netball' } });
  rival = await signUpCoach(t, { email: 'b@x.co.za', school: 'Bravo High', team: { name: 'Bravo Netball', level: '1st_team', sport: 'Netball' } });
  const mine = async (c) => (await t.api('GET', '/api/teams?mine=true', undefined, c.token)).body.teams[0];
  team = await mine(coach);
  rivalTeam = await mine(rival);
});
after(async () => { await t.stop(); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

async function upload(teamId, bytes, { token = coach.token, field = 'photo' } = {}) {
  const form = new FormData();
  if (bytes) form.append(field, new Blob([bytes], { type: 'application/octet-stream' }), 'logo.png');
  const res = await fetch(`${t.origin}/api/teams/${teamId}/logo`, {
    method: 'PUT',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, body: await res.json() };
}

test('a new team has no logo', async () => {
  assert.equal(team.logoUrl, null);
  assert.equal((await t.api('GET', `/api/teams/${team.id}`)).body.team.logoUrl, null);
});

test('the coach uploads a logo and it shows wherever the team does', async () => {
  const res = await upload(team.id, PNG);
  assert.equal(res.status, 200);
  assert.match(res.body.logoUrl, /^https:\/\/res\.cloudinary\.com\/.+team_\d+\.png$/);
  assert.equal(res.body.team.logoUrl, res.body.logoUrl);
  assert.equal(t.teamLogos.at(-1).teamId, team.id);

  assert.equal((await t.api('GET', `/api/teams/${team.id}`)).body.team.logoUrl, res.body.logoUrl);
  assert.equal((await t.api('GET', '/api/coach/dashboard', undefined, coach.token)).body.team.logoUrl, res.body.logoUrl);

  // and on fixtures, which carry both teams
  const fixture = (await t.api('POST', '/api/fixtures', { homeTeamId: team.id, awayTeamId: rivalTeam.id, matchDate: '2026-09-01T15:00:00Z' }, coach.token)).body.fixture;
  assert.equal(fixture.homeTeam.logoUrl, res.body.logoUrl);
  assert.equal(fixture.awayTeam.logoUrl, null);
});

test('a second upload replaces the first', async () => {
  const before = (await t.api('GET', `/api/teams/${team.id}`)).body.team.logoUrl;
  const res = await upload(team.id, PNG);
  assert.equal(res.status, 200);
  assert.notEqual(res.body.logoUrl, before);
  assert.equal((await t.api('GET', `/api/teams/${team.id}`)).body.team.logoUrl, res.body.logoUrl);
});

test('only the team\'s coach (or an admin) can change the logo', async () => {
  assert.equal((await upload(team.id, PNG, { token: rival.token })).status, 403);
  assert.equal((await upload(team.id, PNG, { token: null })).status, 401);
  const learner = await signUpLearner(t);
  assert.equal((await upload(team.id, PNG, { token: learner.token })).status, 403);

  const admin = await signUpLearner(t, { email: 'admin@x.co.za' });
  await makeAdmin(t, admin.email);
  assert.equal((await upload(rivalTeam.id, PNG, { token: admin.token })).status, 200);
});

test('rejects non-images, a missing file and an unknown team', async () => {
  const notImage = await upload(team.id, Buffer.from('this is not really an image at all'));
  assert.equal(notImage.status, 400);
  assert.equal(notImage.body.error.code, 'INVALID_IMAGE');
  assert.equal((await upload(team.id, null)).body.error.code, 'NO_FILE');
  assert.equal((await upload(999999, PNG)).status, 404);
});

test('the coach can remove the logo', async () => {
  const gone = await t.api('DELETE', `/api/teams/${team.id}/logo`, undefined, coach.token);
  assert.equal(gone.status, 200);
  assert.equal(gone.body.logoUrl, null);
  assert.ok(t.deleted.some((id) => id.endsWith(`team_${team.id}`)));
  assert.equal((await t.api('GET', `/api/teams/${team.id}`)).body.team.logoUrl, null);
  assert.equal((await t.api('DELETE', `/api/teams/${team.id}/logo`, undefined, rival.token)).status, 403);
});
