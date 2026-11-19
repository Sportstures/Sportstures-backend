// Learner notifications: the inbox (/api/me/notifications), the settings, and the events that create them
// (fixtures scheduled, changed and finished; join requests and squad changes; lineup selection).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, learnerPayload } = require('./helpers/setup');

let t;
let coachA, coachB, coachC;
let teamA, teamB, teamC;
let player, fan, follower, quiet, stranger; // learners

const learner = (email, firstName, school) => signUpLearner(t, learnerPayload({
  email, firstName, lastName: 'Learner', school: { name: school, grade: 10, className: '10A' }, sport: null,
}));
const mineTeam = async (coach) => (await t.api('GET', '/api/teams?mine=true', undefined, coach.token)).body.teams[0];
const inbox = async (who, qs = '') => {
  const res = await t.api('GET', `/api/me/notifications${qs}`, undefined, who.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};
const types = async (who) => (await inbox(who, '?limit=100')).notifications.map((n) => n.type);
const latest = async (who) => (await inbox(who)).notifications[0];
const schedule = async (coach, home, away, matchDate, extra = {}) => {
  const res = await t.api('POST', '/api/fixtures', { homeTeamId: home.id, awayTeamId: away.id, matchDate, ...extra }, coach.token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.fixture;
};

before(async () => {
  t = await startTestApp();
  const football = (name, school) => ({ school, team: { name, level: '1st_team', sport: 'Football' } });
  coachA = await signUpCoach(t, { email: 'ca@example.com', ...football('Alpha FC', 'Alpha High') });
  coachB = await signUpCoach(t, { email: 'cb@example.com', ...football('Bravo FC', 'Bravo High') });
  coachC = await signUpCoach(t, { email: 'cc@example.com', ...football('Charlie FC', 'Charlie High') });
  [teamA, teamB, teamC] = await Promise.all([coachA, coachB, coachC].map(mineTeam));

  player = await learner('player@example.com', 'Pat', 'Alpha High'); // will play for Alpha FC
  fan = await learner('fan@example.com', 'Fay', 'Delta High'); // favourites Bravo FC
  follower = await learner('follower@example.com', 'Flo', 'Alpha High'); // follows Alpha High (not on a team)
  quiet = await learner('quiet@example.com', 'Quin', 'Delta High'); // favourites Bravo FC, turns results off
  stranger = await learner('stranger@example.com', 'Sol', 'Delta High'); // follows nothing

  for (const who of [fan, quiet]) await t.api('PUT', `/api/me/favorites/teams/${teamB.id}`, undefined, who.token);
  await t.api('PUT', `/api/me/favorites/schools/${teamA.school.id}`, undefined, follower.token);
});

after(async () => {
  await t.stop();
});

test('an empty inbox, everything switched on, and a login is needed', async () => {
  assert.deepEqual(await inbox(stranger), {
    notifications: [], unreadCount: 0, total: 0, limit: 20, offset: 0, hasMore: false,
  });
  const settings = await t.api('GET', '/api/me/notifications/settings', undefined, stranger.token);
  assert.deepEqual(settings.body.settings, { matchResults: true, fixtureChanges: true, teamMembership: true, lineupSelection: true });
  assert.equal((await t.api('GET', '/api/me/notifications')).status, 401);
  assert.equal((await t.api('GET', '/api/me/notifications/unread-count')).status, 401);
});

test('join request approved, squad added and removed reach the learner', async () => {
  await t.api('POST', `/api/teams/${teamA.id}/join-requests`, {}, player.token);
  const approved = await t.api('PATCH', `/api/teams/${teamA.id}/roster/${player.user.id}`, { status: 'active' }, coachA.token);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const n = await latest(player);
  assert.equal(n.type, 'join_approved');
  assert.equal(n.category, 'teamMembership');
  assert.equal(n.title, "You're in: Alpha FC");
  assert.deepEqual(n.data, { teamId: teamA.id });
  assert.equal(n.read, false);

  // A request the coach turns down, and a learner the coach adds and then removes.
  await t.api('POST', `/api/teams/${teamC.id}/join-requests`, {}, stranger.token);
  await t.api('DELETE', `/api/teams/${teamC.id}/roster/${stranger.user.id}`, undefined, coachC.token);
  assert.equal((await latest(stranger)).type, 'join_declined');
  await t.api('POST', `/api/teams/${teamA.id}/roster`, { userId: follower.user.id }, coachA.token);
  assert.equal((await latest(follower)).type, 'squad_added');
  await t.api('DELETE', `/api/teams/${teamA.id}/roster/${follower.user.id}`, undefined, coachA.token);
  assert.equal((await latest(follower)).title, 'Removed from Alpha FC');
});

test('a new fixture reaches players, team fans and school followers, not others', async () => {
  const before = { player: (await inbox(player)).total, fan: (await inbox(fan)).total, follower: (await inbox(follower)).total };
  const fx = await schedule(coachA, teamA, teamB, '2099-06-06T08:00:00Z', { venue: 'Alpha Field' });

  for (const [name, who] of [['player', player], ['fan', fan], ['follower', follower]]) {
    const box = await inbox(who);
    assert.equal(box.total, before[name] + 1, `${name} is told`);
    assert.equal(box.notifications[0].type, 'fixture_scheduled');
  }
  const n = await latest(fan);
  assert.equal(n.title, 'New match: Alpha FC v Bravo FC');
  assert.equal(n.body, 'Sat 6 Jun, 10:00 · Alpha Field', 'South African time');
  assert.deepEqual(n.data, { fixtureId: fx.id, homeTeamId: teamA.id, awayTeamId: teamB.id, competitionId: null });

  assert.ok(!(await types(stranger)).includes('fixture_scheduled'), 'followers only');
  assert.equal((await inbox({ token: coachA.token })).total, 0, 'coaches get none');
});

test('postponing, moving and cancelling a fixture are each announced once', async () => {
  const fx = await schedule(coachA, teamA, teamB, '2099-07-01T08:00:00Z');
  const count = async () => (await inbox(fan)).total;
  const start = await count();

  await t.api('PATCH', `/api/fixtures/${fx.id}`, { status: 'postponed' }, coachA.token);
  assert.equal((await latest(fan)).title, 'Postponed: Alpha FC v Bravo FC');

  await t.api('PATCH', `/api/fixtures/${fx.id}`, { status: 'scheduled', matchDate: '2099-07-08T08:00:00Z' }, coachA.token);
  const moved = await latest(fan);
  assert.equal(moved.type, 'fixture_rescheduled');
  assert.equal(moved.title, 'Back on: Alpha FC v Bravo FC');
  assert.equal(moved.body, 'Wed 8 Jul, 10:00');

  await t.api('PATCH', `/api/fixtures/${fx.id}`, { matchType: 'friendly' }, coachA.token);
  assert.equal(await count(), start + 2, 'a change the learner does not see is not announced');

  await t.api('PATCH', `/api/fixtures/${fx.id}`, { status: 'cancelled' }, coachA.token);
  assert.equal((await latest(fan)).type, 'fixture_cancelled');
  assert.equal(await count(), start + 3);
});

test('results reach followers; turning match results off stops them', async () => {
  const off = await t.api('PUT', '/api/me/notifications/settings', { matchResults: false }, quiet.token);
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual(off.body.settings, { matchResults: false, fixtureChanges: true, teamMembership: true, lineupSelection: true });

  const fx = await schedule(coachA, teamA, teamB, '2026-01-10T08:00:00Z');
  const scored = await t.api('PUT', `/api/fixtures/${fx.id}/result`, { homeScore: 2, awayScore: 1 }, coachA.token);
  assert.equal(scored.status, 200, JSON.stringify(scored.body));

  const n = await latest(fan);
  assert.equal(n.type, 'match_result');
  assert.equal(n.title, 'Full time: Alpha FC 2 - 1 Bravo FC');
  assert.equal(n.body, 'Friendly');
  assert.equal((await latest(player)).type, 'match_result');
  assert.ok(!(await types(quiet)).includes('match_result'), 'switched off');
  assert.ok((await types(quiet)).includes('fixture_scheduled'), 'other types still arrive');

  await t.api('PUT', `/api/fixtures/${fx.id}/result`, { homeScore: 2, awayScore: 2 }, coachA.token);
  assert.equal((await latest(fan)).title, 'Result corrected: Alpha FC 2 - 2 Bravo FC');
});

test('named in a lineup: starters and bench are told; resubmitting only tells the changes', async () => {
  const second = await learner('second@example.com', 'Sid', 'Alpha High');
  await t.api('POST', `/api/teams/${teamA.id}/roster`, { userId: second.user.id }, coachA.token);
  const fx = await schedule(coachA, teamA, teamC, '2099-08-01T08:00:00Z');

  const submit = (body) => t.api('PUT', `/api/fixtures/${fx.id}/lineups/${teamA.id}`, body, coachA.token);
  assert.equal((await submit({ starters: [{ userId: player.user.id }], bench: [{ userId: second.user.id }] })).status, 200);
  const starting = await latest(player);
  assert.equal(starting.type, 'lineup_selected');
  assert.equal(starting.title, "You're starting: Alpha FC v Charlie FC");
  assert.equal(starting.data.role, 'starter');
  assert.equal((await latest(second)).title, "You're on the bench: Alpha FC v Charlie FC");

  const count = async (who) => (await types(who)).filter((x) => x === 'lineup_selected').length;
  await submit({ starters: [{ userId: player.user.id }, { userId: second.user.id }] });
  assert.equal(await count(player), 1, 'unchanged: not told again');
  assert.equal(await count(second), 2, 'moved from the bench to starting');
  assert.equal((await latest(second)).data.role, 'starter');
});

test('reading, unread counts, paging and deleting', async () => {
  const box = await inbox(player);
  assert.ok(box.unreadCount >= 4);
  assert.equal((await t.api('GET', '/api/me/notifications/unread-count', undefined, player.token)).body.unreadCount, box.unreadCount);

  const first = box.notifications[0];
  const read = await t.api('PUT', `/api/me/notifications/${first.id}/read`, undefined, player.token);
  assert.equal(read.status, 200);
  assert.equal(read.body.notification.read, true);
  assert.equal(read.body.unreadCount, box.unreadCount - 1);
  assert.ok(!(await inbox(player, '?unread=true')).notifications.some((n) => n.id === first.id));

  const unread = await t.api('DELETE', `/api/me/notifications/${first.id}/read`, undefined, player.token);
  assert.equal(unread.body.notification.read, false);

  const page = await inbox(player, '?limit=2&offset=1');
  assert.equal(page.notifications.length, 2);
  assert.equal(page.notifications[0].id, box.notifications[1].id);
  assert.equal(page.hasMore, box.total > 3);

  const all = await t.api('POST', '/api/me/notifications/read-all', undefined, player.token);
  assert.equal(all.body.unreadCount, 0);
  assert.equal(all.body.marked, box.unreadCount);

  const gone = await t.api('DELETE', `/api/me/notifications/${first.id}`, undefined, player.token);
  assert.equal(gone.status, 200);
  assert.equal((await inbox(player)).total, box.total - 1);
  assert.equal((await t.api('DELETE', `/api/me/notifications/${first.id}`, undefined, player.token)).status, 404);

  const others = (await inbox(fan)).notifications[0];
  assert.equal((await t.api('PUT', `/api/me/notifications/${others.id}/read`, undefined, player.token)).status, 404, 'only your own');
});

test('settings validation', async () => {
  const put = (body) => t.api('PUT', '/api/me/notifications/settings', body, stranger.token);
  assert.equal((await put({})).body.error.code, 'NOTHING_TO_UPDATE');
  assert.equal((await put({ lineupSelection: 'no' })).status, 400);
  const res = await put({ lineupSelection: false, fixtureChanges: false });
  assert.deepEqual(res.body.settings, { matchResults: true, fixtureChanges: false, teamMembership: true, lineupSelection: false });
  const back = await put({ fixtureChanges: true });
  assert.equal(back.body.settings.fixtureChanges, true);
  assert.equal(back.body.settings.lineupSelection, false, 'others are kept');
});
