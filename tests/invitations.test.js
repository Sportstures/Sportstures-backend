const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, coachPayload } = require('./helpers/setup');

let t; let sipho; let other;

before(async () => {
  t = await startTestApp();
  sipho = await signUpCoach(t, { email: 'sipho@a.co.za', school: 'Jeppe High', team: { name: 'Jeppe Football', level: '1st_team', sport: 'Football' } });
  other = await signUpCoach(t, { email: 'other@b.co.za', school: 'Parktown Boys', team: { name: 'Parktown Rugby', level: '1st_team', sport: 'Rugby' } });
});
after(async () => { await t.stop(); });

const invite = (body, token = sipho.token) => t.api('POST', '/api/invitations', body, token);
const register = (email, school, sport, inviteCode) => t.api('POST', '/api/auth/register/coach', coachPayload({
  email, school, inviteCode, team: { name: `${school} ${sport}`, level: '1st_team', sport },
}));

test('invite by email: sends an email from the coach and school, with a registration link', async () => {
  const res = await invite({ email: 'Head@Newschool.co.za' });
  assert.equal(res.status, 201);
  assert.equal(res.body.invitation.kind, 'email');
  assert.equal(res.body.invitation.email, 'head@newschool.co.za');
  assert.equal(res.body.invitation.status, 'pending');
  assert.equal(res.body.invitation.emailSent, true);
  const sent = t.sentInvites.at(-1);
  assert.equal(sent.to, 'head@newschool.co.za');
  assert.equal(sent.inviterName, 'Sipho Williams');
  assert.equal(sent.schoolName, 'Jeppe High');
  assert.match(sent.link, /\/signup\?invite=[\w-]{20,}$/);
  assert.equal(sent.link, res.body.invitation.link);
});

test('inviting the same address again resends the same invitation instead of making a second', async () => {
  const sentBefore = t.sentInvites.length;
  const again = await invite({ email: 'head@newschool.co.za' });
  assert.equal(again.status, 200);
  assert.equal(t.sentInvites.length, sentBefore + 1);
  const list = (await t.api('GET', '/api/invitations', undefined, sipho.token)).body.invitations;
  assert.equal(list.filter((i) => i.email === 'head@newschool.co.za').length, 1);
});

test('email rules: valid address, not yourself, not already registered', async () => {
  assert.equal((await invite({ email: 'not-an-email' })).status, 400);
  assert.equal((await invite({ email: 'sipho@a.co.za' })).body.error.code, 'INVITE_SELF');
  const taken = await invite({ email: 'other@b.co.za' });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'ALREADY_REGISTERED');
});

test('if the email cannot be sent the coach is told and no invitation is left behind', async () => {
  t.control.failInvites = true;
  const res = await invite({ email: 'broken@x.co.za' });
  t.control.failInvites = false;
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'EMAIL_FAILED');
  const rows = await t.pool.query("SELECT 1 FROM invitations WHERE email = 'broken@x.co.za'");
  assert.equal(rows.rowCount, 0);
});

test('share link: one reusable link per coach', async () => {
  const first = await invite({});
  assert.equal(first.status, 201);
  assert.equal(first.body.invitation.kind, 'link');
  assert.equal(first.body.invitation.email, null);
  const second = await invite({});
  assert.equal(second.status, 200);
  assert.equal(second.body.invitation.link, first.body.invitation.link);
  const others = await invite({}, other.token);
  assert.notEqual(others.body.invitation.link, first.body.invitation.link);
});

test('only coaches (and admins) can invite; visitors cannot', async () => {
  assert.equal((await t.api('POST', '/api/invitations', {})).status, 401);
  const learner = await signUpLearner(t);
  assert.equal((await invite({}, learner.token)).status, 403);
  assert.equal((await t.api('GET', '/api/invitations', undefined, learner.token)).status, 403);
});

test('the signup page can look up an invitation without logging in', async () => {
  const link = (await invite({})).body.invitation;
  const res = await t.api('GET', `/api/invitations/${link.code}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { valid: true, inviterName: 'Sipho Williams', schoolName: 'Jeppe High', email: null });
  const mail = (await invite({ email: 'head@newschool.co.za' })).body.invitation;
  assert.equal((await t.api('GET', `/api/invitations/${mail.code}`)).body.email, 'head@newschool.co.za');
  assert.equal((await t.api('GET', '/api/invitations/nonsense')).status, 404);
});

test('coaches who register with the share link are counted as joined, and many can use one link', async () => {
  const link = (await invite({})).body.invitation;
  assert.equal((await register('new0@c.co.za', 'Northcliff High', 'Hockey', link.code)).status, 201);
  assert.equal((await register('new1@c.co.za', 'Roodepoort High', 'Hockey', link.code)).status, 201);
  const list = (await t.api('GET', '/api/invitations', undefined, sipho.token)).body;
  assert.equal(list.invitations.find((i) => i.kind === 'link').joined, 2);
  assert.ok(list.joined >= 2);
});

test('an email invitation becomes accepted once that coach registers', async () => {
  const mail = (await invite({ email: 'head@newschool.co.za' })).body.invitation;
  assert.equal((await register('head@newschool.co.za', 'New School', 'Netball', mail.code)).status, 201);
  const list = (await t.api('GET', '/api/invitations', undefined, sipho.token)).body.invitations;
  assert.equal(list.find((i) => i.id === mail.id).status, 'accepted');
});

test('a wrong or expired code never blocks signup', async () => {
  assert.equal((await register('bad@c.co.za', 'Some School', 'Cricket', 'not-a-real-code')).status, 201);

  const link = (await invite({}, other.token)).body.invitation;
  await t.pool.query("UPDATE invitations SET expires_at = NOW() - interval '1 day' WHERE id = $1", [link.id]);
  assert.equal((await t.api('GET', `/api/invitations/${link.code}`)).status, 404);
  assert.equal((await register('late@c.co.za', 'Late School', 'Squash', link.code)).status, 201);
  assert.equal((await t.pool.query("SELECT invitation_id FROM users WHERE email = 'late@c.co.za'")).rows[0].invitation_id, null);
  // an expired share link is replaced with a fresh one
  const fresh = await invite({}, other.token);
  assert.notEqual(fresh.body.invitation.code, link.code);
  assert.equal(fresh.body.invitation.status, 'pending');
});

test("cancelling an invitation kills its link; you cannot cancel someone else's", async () => {
  const mail = (await invite({ email: 'cancel@x.co.za' })).body.invitation;
  assert.equal((await t.api('DELETE', `/api/invitations/${mail.id}`, undefined, other.token)).status, 404);
  assert.equal((await t.api('DELETE', `/api/invitations/${mail.id}`, undefined, sipho.token)).status, 204);
  assert.equal((await t.api('GET', `/api/invitations/${mail.code}`)).status, 404);
  const list = (await t.api('GET', '/api/invitations', undefined, sipho.token)).body.invitations;
  assert.ok(!list.some((i) => i.id === mail.id));
});

test('a coach can only send so many invitation emails a day', async () => {
  const sender = await signUpCoach(t, { email: 'busy@d.co.za', school: 'Busy High', team: { name: 'Busy Chess', level: '1st_team', sport: 'Chess' } });
  for (let i = 0; i < 20; i += 1) assert.equal((await invite({ email: `p${i}@x.co.za` }, sender.token)).status, 201);
  const over = await invite({ email: 'p21@x.co.za' }, sender.token);
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, 'INVITE_LIMIT');
});
