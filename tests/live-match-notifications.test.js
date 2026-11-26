// Learners following a match hear when it kicks off, when a goal counts, and when a counted goal is removed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, signUpCoach, signUpLearner, makeAdmin, learnerPayload } = require('./helpers/setup');

let t;
let home, away, player, fan, follower, stranger, quiet, admin;

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const teamOf = async (coach) => (await t.api('GET', '/api/teams?mine=true', undefined, coach.token)).body.teams[0];
const post = (who, url, body = {}) => t.api('POST', url, body, who.token);
const inbox = async (who) => (await t.api('GET', '/api/me/notifications?limit=100', undefined, who.token)).body.notifications;
const live = (notes, id) => notes.filter((n) => n.category === 'liveMatches' && n.data.fixtureId === id);

async function liveFixture() {
  const res = await post(home, '/api/fixtures', { homeTeamId: home.team.id, awayTeamId: away.team.id, matchDate: now(), venue: 'Jeppe Field' });
  const id = res.body.fixture.id;
  assert.equal((await post(home, `/api/fixtures/${id}/start`)).status, 200);
  return id;
}

before(async () => {
  t = await startTestApp();
  home = await signUpCoach(t, { email: 'home@example.com', school: 'Jeppe High', team: { name: 'Jeppe Football', level: '1st_team', sport: 'Football' } });
  away = await signUpCoach(t, { email: 'away@example.com', school: 'Greenwood', team: { name: 'Greenwood Football', level: '1st_team', sport: 'Football' } });
  for (const c of [home, away]) c.team = await teamOf(c);

  player = await signUpLearner(t, learnerPayload({ email: 'player@example.com', firstName: 'Thabo', lastName: 'Mokoena' }));
  fan = await signUpLearner(t, learnerPayload({ email: 'fan@example.com' }));
  follower = await signUpLearner(t, learnerPayload({ email: 'follower@example.com' }));
  stranger = await signUpLearner(t, learnerPayload({ email: 'stranger@example.com' }));
  quiet = await signUpLearner(t, learnerPayload({ email: 'quiet@example.com' }));
  admin = await signUpLearner(t, learnerPayload({ email: 'admin@example.com' }));
  await makeAdmin(t, 'admin@example.com');

  assert.equal((await post(home, `/api/teams/${home.team.id}/roster`, { userId: player.user.id })).status, 201);
  const put = (who, url) => t.api('PUT', url, undefined, who.token);
  assert.equal((await put(fan, `/api/me/favorites/teams/${away.team.id}`)).status, 200);
  assert.equal((await put(quiet, `/api/me/favorites/teams/${away.team.id}`)).status, 200);
  assert.equal((await put(follower, `/api/me/favorites/schools/${away.team.school.id}`)).status, 200);
  await t.api('PUT', '/api/me/notifications/settings', { liveMatches: false }, quiet.token);
});
after(async () => { await t.stop(); });

test('kick-off reaches players, team fans and school followers', async () => {
  const id = await liveFixture();
  for (const who of [player, fan, follower]) {
    const [n] = live(await inbox(who), id);
    assert.ok(n, `${who.email} hears about kick-off`);
    assert.equal(n.type, 'match_started');
    assert.equal(n.title, 'Kick-off: Jeppe Football v Greenwood Football');
    assert.match(n.body, /Jeppe Field/);
  }
  assert.equal(live(await inbox(stranger), id).length, 0, 'not people who follow neither team nor school');
  assert.equal(live(await inbox(quiet), id).length, 0, 'not people who switched it off');
  assert.equal(live(await inbox(home), id).length, 0, 'not coaches');
});

test('a goal reaches learners only once it counts, with the new score', async () => {
  const id = await liveFixture();
  const goal = (await post(home, `/api/fixtures/${id}/goals`, { minute: 23, playerId: player.user.id })).body.goal;
  assert.equal(live(await inbox(fan), id).filter((n) => n.type === 'goal_scored').length, 0, 'pending goals are not announced');

  await post(away, `/api/fixtures/${id}/goals/${goal.id}/confirm`);
  const [n] = live(await inbox(fan), id).filter((x) => x.type === 'goal_scored');
  assert.equal(n.title, 'Goal Jeppe Football: Jeppe Football 1 - 0 Greenwood Football');
  assert.equal(n.body, "23' · Thabo Mokoena");
  assert.equal(n.data.fixtureId, id);
  assert.ok(live(await inbox(player), id).some((x) => x.type === 'goal_scored'));
  assert.equal(live(await inbox(quiet), id).length, 0);

  // A disputed goal never reaches learners.
  const disputed = (await post(away, `/api/fixtures/${id}/goals`, { minute: 30 })).body.goal;
  await post(home, `/api/fixtures/${id}/goals/${disputed.id}/dispute`, { reason: 'Offside' });
  assert.equal(live(await inbox(fan), id).filter((x) => x.type === 'goal_scored').length, 1);
});

test('removing a goal that had counted tells learners; removing one that never counted does not', async () => {
  const id = await liveFixture();
  const counted = (await post(away, `/api/fixtures/${id}/goals`, { minute: 40 })).body.goal;
  await post(home, `/api/fixtures/${id}/goals/${counted.id}/confirm`);
  const pending = (await post(away, `/api/fixtures/${id}/goals`, { minute: 41 })).body.goal;

  await t.api('DELETE', `/api/fixtures/${id}/goals/${pending.id}`, undefined, away.token);
  assert.equal(live(await inbox(fan), id).filter((n) => n.type === 'goal_removed').length, 0);

  await t.api('DELETE', `/api/fixtures/${id}/goals/${counted.id}`, undefined, away.token);
  const [n] = live(await inbox(fan), id).filter((x) => x.type === 'goal_removed');
  assert.equal(n.title, 'Goal ruled out: Greenwood Football');
  assert.match(n.body, /40'/);
  assert.match(n.body, /Now Jeppe Football 0 - 0 Greenwood Football/);
});

test('an admin\'s goal counts straight away, so it is announced straight away', async () => {
  const id = await liveFixture();
  await post(admin, `/api/fixtures/${id}/goals`, { teamId: away.team.id, minute: 5 });
  const [n] = live(await inbox(follower), id).filter((x) => x.type === 'goal_scored');
  assert.equal(n.title, 'Goal Greenwood Football: Jeppe Football 0 - 1 Greenwood Football');
});

test('full time sends the result, not a goal notification for each auto-confirmed goal', async () => {
  const id = await liveFixture();
  await post(home, `/api/fixtures/${id}/goals`, { minute: 70 });
  await post(home, `/api/fixtures/${id}/finish`);
  const mine = (await inbox(fan)).filter((n) => n.data.fixtureId === id);
  assert.equal(mine.filter((n) => n.type === 'goal_scored').length, 0);
  assert.ok(mine.some((n) => n.type === 'match_result' && /Jeppe Football 1 - 0 Greenwood Football/.test(n.title)));
});
