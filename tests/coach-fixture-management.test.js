// Either team's coach can edit and cancel a fixture and set their own lineup; the other coach is told.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, learnerPayload } = require('./helpers/setup');

let t;
let home, away, outsider, homePlayer, awayPlayer;

const inDays = (days) => new Date(Date.now() + days * 86400000).toISOString().replace(/\.\d+Z$/, 'Z');
const teamOf = async (coach) => (await t.api('GET', '/api/teams?mine=true', undefined, coach.token)).body.teams[0];
const inbox = async (who) => (await t.api('GET', '/api/me/notifications', undefined, who.token)).body.notifications;
const patch = (who, id, body) => t.api('PATCH', `/api/fixtures/${id}`, body, who.token);

async function fixture() {
  const res = await t.api('POST', '/api/fixtures', { homeTeamId: home.team.id, awayTeamId: away.team.id, matchDate: inDays(5), venue: 'Jeppe Field' }, home.token);
  assert.equal(res.status, 201);
  return res.body.fixture.id;
}

before(async () => {
  t = await startTestApp();
  home = await signUpCoach(t, { email: 'home@example.com', school: 'Jeppe High', team: { name: 'Jeppe Netball', level: 'u16', sport: 'Netball' } });
  away = await signUpCoach(t, { email: 'away@example.com', school: 'Greenwood', team: { name: 'Greenwood Netball', level: 'u16', sport: 'Netball' } });
  outsider = await signUpCoach(t, { email: 'out@example.com', school: 'Parktown', team: { name: 'Parktown Netball', level: 'u16', sport: 'Netball' } });
  for (const c of [home, away, outsider]) c.team = await teamOf(c);
  homePlayer = await signUpLearner(t, learnerPayload({ email: 'hp@example.com' }));
  awayPlayer = await signUpLearner(t, learnerPayload({
    email: 'ap@example.com', school: { name: 'Greenwood', grade: 9, className: '9A' },
  }));
  assert.equal((await t.api('POST', `/api/teams/${home.team.id}/roster`, { userId: homePlayer.user.id }, home.token)).status, 201);
  assert.equal((await t.api('POST', `/api/teams/${away.team.id}/roster`, { userId: awayPlayer.user.id }, away.token)).status, 201);
});
after(async () => { await t.stop(); });

test('scheduling a fixture tells the other coach', async () => {
  const id = await fixture();
  const note = (await inbox(away)).find((n) => n.type === 'fixture_scheduled' && n.data.fixtureId === id);
  assert.ok(note, 'the away coach hears about the new match');
  assert.ok(!(await inbox(home)).some((n) => n.data.fixtureId === id), 'not the coach who scheduled it');
  assert.ok(!(await inbox(outsider)).some((n) => n.data.fixtureId === id), 'not a coach of another team');
});

test('the away coach can edit a fixture; the home coach and players are told', async () => {
  const id = await fixture();
  const edited = await patch(away, id, { venue: 'Greenwood Courts', matchDate: inDays(6) });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.fixture.venue, 'Greenwood Courts');

  const toHome = (await inbox(home)).find((n) => n.type === 'fixture_rescheduled' && n.data.fixtureId === id);
  assert.ok(toHome, 'the home coach is told');
  assert.match(toHome.body, /Greenwood Courts/);
  assert.ok((await inbox(homePlayer)).some((n) => n.type === 'fixture_rescheduled' && n.data.fixtureId === id));
  assert.ok(!(await inbox(away)).some((n) => n.type === 'fixture_rescheduled' && n.data.fixtureId === id), 'not the coach who changed it');

  assert.equal((await patch(outsider, id, { venue: 'x' })).status, 403);
  assert.equal((await patch(homePlayer, id, { venue: 'x' })).status, 403);
});

test('either coach can postpone or cancel, and bring a postponed match back', async () => {
  const id = await fixture();
  assert.equal((await patch(away, id, { status: 'postponed' })).body.fixture.status, 'postponed');
  assert.ok((await inbox(home)).some((n) => n.type === 'fixture_postponed' && n.data.fixtureId === id));
  assert.equal((await patch(home, id, { status: 'scheduled' })).body.fixture.status, 'scheduled');
  assert.ok((await inbox(away)).some((n) => n.type === 'fixture_rescheduled' && n.data.fixtureId === id));

  const cancelled = await patch(away, id, { status: 'cancelled' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.fixture.status, 'cancelled');
  assert.ok((await inbox(home)).some((n) => n.type === 'fixture_cancelled' && n.data.fixtureId === id));
  assert.ok((await inbox(awayPlayer)).some((n) => n.type === 'fixture_cancelled' && n.data.fixtureId === id));
});

test('coaches can switch fixture change notifications off', async () => {
  await t.api('PUT', '/api/me/notifications/settings', { fixtureChanges: false }, outsider.token);
  const res = await t.api('POST', '/api/fixtures', { homeTeamId: home.team.id, awayTeamId: outsider.team.id, matchDate: inDays(9) }, home.token);
  await patch(home, res.body.fixture.id, { status: 'cancelled' });
  assert.ok(!(await inbox(outsider)).some((n) => n.data.fixtureId === res.body.fixture.id));
});

test('each coach sets their own team\'s lineup, not the other team\'s', async () => {
  const id = await fixture();
  const homeLineup = await t.api('PUT', `/api/fixtures/${id}/lineups/${home.team.id}`, { starters: [{ userId: homePlayer.user.id, position: 'GA' }] }, home.token);
  assert.equal(homeLineup.status, 200);
  const awayLineup = await t.api('PUT', `/api/fixtures/${id}/lineups/${away.team.id}`, { starters: [{ userId: awayPlayer.user.id, position: 'GK' }] }, away.token);
  assert.equal(awayLineup.status, 200);

  assert.equal((await t.api('PUT', `/api/fixtures/${id}/lineups/${away.team.id}`, { starters: [{ userId: awayPlayer.user.id }] }, home.token)).status, 403);
  assert.equal((await t.api('PUT', `/api/fixtures/${id}/lineups/${home.team.id}`, { starters: [{ userId: homePlayer.user.id }] }, outsider.token)).status, 403);

  const f = (await t.api('GET', `/api/fixtures/${id}`)).body.fixture;
  assert.deepEqual(f.lineupSubmitted, { home: true, away: true });

  // A cancelled match takes no lineup.
  await patch(away, id, { status: 'cancelled' });
  const closed = await t.api('PUT', `/api/fixtures/${id}/lineups/${home.team.id}`, { starters: [{ userId: homePlayer.user.id }] }, home.token);
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error.code, 'FIXTURE_CLOSED');
});

test('accepting a match invitation does not also send the coaches a "new match" notification', async () => {
  const inv = (await t.api('POST', '/api/match-invitations', { opponentTeamId: away.team.id, matchDate: inDays(12) }, home.token)).body.invitation;
  const accepted = await t.api('POST', `/api/match-invitations/${inv.id}/accept`, {}, away.token);
  const fixtureId = accepted.body.invitation.fixtureId;
  for (const coach of [home, away]) {
    assert.ok(!(await inbox(coach)).some((n) => n.type === 'fixture_scheduled' && n.data.fixtureId === fixtureId));
  }
  assert.ok((await inbox(homePlayer)).some((n) => n.type === 'fixture_scheduled' && n.data.fixtureId === fixtureId), 'players still hear');
});
