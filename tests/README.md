# Tests

```
npm test
```

Needs Node 18 or newer and PostgreSQL running, with `DB_USER`, `DB_PASSWORD`, `DB_HOST` and `DB_PORT` set in `.env`.
Takes about 20 seconds.

## What happens

Each test file creates its **own temporary database** (named `sportstures_test_...`), builds it like a fresh
install (`db/schema.sql` plus every file in `db/migrations`, in name order), runs the real app against it, and
drops it afterwards. **Your real `sportstures` database is never touched.** Emails are not sent; the tests read
the verification codes directly.

| File | Covers |
|---|---|
| `auth.test.js` | Learner and coach signup, email verification, login, refresh tokens, logout, validation, permissions |
| `teams-fixtures.test.js` | Teams, competitions, fixtures: permissions, filters, time zones, database constraints |
| `results.test.js`, `standings.test.js` | Recording results, league tables, team records, match reports |
| `roster.test.js` | Joining teams, approvals, jersey numbers, roster privacy |
| `lineups.test.js` | Submitting lineups, roster checks, lineup privacy, locking |
| `public-reads.test.js` | Which routes need no login, and which stay private |
| `schools.test.js` | School province and town, the schools endpoints, who can edit them |
| `seed-demo.test.js` | The demo data script: contents, repeatable, reset leaves real data alone |
| `coach-dashboard.test.js` | The coach home summary: squad, record, next match, action items |
| `migrations.test.js` | A fresh install works, migrations can be re-run, old users move to the roles table |

## Adding tests when you add a feature

1. Copy the top of an existing test file (`startTestApp()` in `before`, `t.stop()` in `after`).
2. Use `t.api(method, url, body, token)` to call the API, and `t.pool.query(...)` to look at the database.
3. Helpers in `helpers/setup.js` create verified users: `signUpLearner`, `signUpCoach`, `makeAdmin`.
4. When you fix a bug, add a test that fails without the fix (see the `REGRESSION` test in `auth.test.js`).

## If a test run is killed

A killed run can leave a database named `sportstures_test_...` behind. It is safe to drop in pgAdmin.
