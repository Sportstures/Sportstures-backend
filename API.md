# Sportstures API

Shared reference for the website and mobile app. **Add every new endpoint here.**

Base URL (local): `http://localhost:5000`

All requests and responses are JSON. Protected routes need the header
`Authorization: Bearer <accessToken>`.

## Public routes (no login needed)

The read-only match data is public so the website can show it to visitors:

- `GET /api/sports` and `GET /api/sports/categories`
- `GET /api/schools` and `GET /api/schools/:id`
- `GET /api/fixtures` and `GET /api/fixtures/:id`
- `GET /api/results`, `GET /api/results/filters` and `GET /api/results/standings`
- `GET /api/rankings`, `GET /api/rankings/overview` and `GET /api/rankings/filters`
- `GET /api/competitions`, `GET /api/competitions/:id` and `GET /api/competitions/:id/standings`
- `GET /api/teams`, `GET /api/teams/:id` and `GET /api/teams/:id/record`

Everything else needs a login: rosters, join requests, lineups, match reports, `/api/me/...`, and every write.
`?mine=true` and `?favorites=true` on the fixture and team lists also need one (`401 NO_TOKEN` without it).
If a request **does** send an `Authorization` header it must be valid, so an expired token still answers
`TOKEN_EXPIRED` and the client can refresh. Team objects include the coach's name.

## Errors

Every error has the same shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid input", "details": [{ "field": "email", "message": "A valid email is required" }] } }
```

`details` is only present for `VALIDATION_ERROR`.

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad input, see `details` |
| 400 | `INVALID_OTP` | Verification code is invalid or expired |
| 401 | `NO_TOKEN` | No Bearer token sent |
| 401 | `INVALID_TOKEN` | Access token invalid |
| 401 | `TOKEN_EXPIRED` | Access token expired: call `/refresh` and retry |
| 401 | `INVALID_CREDENTIALS` | Wrong email or password |
| 401 | `INVALID_REFRESH_TOKEN` | Refresh token unknown or already used: log in again |
| 401 | `REFRESH_TOKEN_EXPIRED` | Refresh token expired: log in again |
| 403 | `FORBIDDEN` | Logged in but role not allowed |
| 403 | `EMAIL_NOT_VERIFIED` | Verify your email before logging in |
| 409 | `EMAIL_TAKEN` | Email already registered |
| 409 | `COACH_TEAM_EXISTS` | A coach already has a team |
| 409 | `COACH_PROFILE_MISSING` | Coach account has no coach profile |
| 400 | `ROLE_REQUIRED` | `POST /api/auth/register` needs `"role": "learner"`; coaches use `/register/coach` |
| 400 | `UNKNOWN_SPORT` | `sportId` does not exist |
| 400 | `SAME_TEAM` / `SPORT_MISMATCH` / `UNKNOWN_COMPETITION` | Fixture rules, see Teams, competitions and fixtures |
| 404 | `NOT_FOUND` | No team, fixture or competition with that id |
| 404 | `REPORT_NOT_FOUND` | No match report has been filed for the fixture |
| 409 | `COMPETITION_EXISTS` | A competition with this name already exists |
| 409 | `FIXTURE_LOCKED` | A live or finished fixture can no longer be edited with PATCH |
| 409 | `FIXTURE_NOT_STARTED` / `FIXTURE_NOT_PLAYABLE` / `FIXTURE_NOT_FINISHED` | Result or report not allowed in the fixture's current state |
| 400 | `NOT_A_LEARNER` | Only learners can be added to a team roster |
| 409 | `ALREADY_MEMBER` / `REQUEST_PENDING` | Learner is already on the team, or has already asked to join |
| 409 | `JERSEY_TAKEN` | Another active player on the team has that number |
| 409 | `SCHOOL_MISMATCH` / `TEAM_SCHOOL_REQUIRED` | Learner is not at the team's school, or the team has no school set |
| 422 | — | Invalid coach signup input; `errors` maps fields to messages |
| 429 | `TOO_MANY_REQUESTS` | Rate limited; resend also returns a `Retry-After` header |

## Contact

### GET /api/contact

Public. Use these addresses on contact pages, footers and help screens instead of hard-coding them.

Response `200`:

```json
{
  "contacts": {
    "support": { "email": "support@sportstures.co.za", "use": "Help with your account or the app" },
    "info": { "email": "info@sportstures.co.za", "use": "General enquiries" },
    "hello": { "email": "hello@sportstures.co.za", "use": "Say hello or get in touch" },
    "partnerships": { "email": "partnerships@sportstures.co.za", "use": "Schools and businesses" },
    "privacy": { "email": "privacy@sportstures.co.za", "use": "Privacy and personal information requests" },
    "security": { "email": "security@sportstures.co.za", "use": "Report a security issue" },
    "billing": { "email": "billing@sportstures.co.za", "use": "Billing questions" }
  }
}
```

`GET /.well-known/security.txt` publishes the security address in the standard format.

## Auth

Access tokens last 15 minutes. Refresh tokens last 30 days and are **single use**:
each `/refresh` returns a new pair, so always save the newest `refreshToken`.

Client flow: store both tokens (secure storage on mobile). When a request returns
`TOKEN_EXPIRED`, call `/refresh`, save the new pair and retry once. If `/refresh`
fails, send the user to the login screen.

### Roles

Roles live in the `roles` table: `learner`, `coach`, `admin`. `user.role` in every response is the role name.
Adding a new role later (for example `school`) is one `INSERT INTO roles`, no code change to the table itself.
Only `learner` and `coach` can be chosen at registration. Admins are set manually in the database.

### POST /api/auth/register

Learner registration creates an unverified learner and emails a six-digit OTP.
Configure `SMTP_HOST` and `SMTP_FROM` (and, when required, `SMTP_USER` and
`SMTP_PASSWORD`) before accepting learner registrations. The sport step may be
skipped by sending `sport: null` or omitting the property.

```json
{
  "role": "learner",
  "firstName": "Ada",
  "lastName": "Obi",
  "dateOfBirth": "2009-03-14",
  "gender": "female",
  "school": { "name": "Example School", "grade": 10, "className": "10A" },
  "sport": { "name": "Football", "teamName": "Falcons", "jerseyNumber": 7, "level": "U16" },
  "email": "ada@example.com",
  "password": "Passw0rdOK"
}
```

Learner registration also accepts the legacy `role: "player"` value, but
stores the account with role `learner`. It requires all personal and school
fields. Gender is `male` or `female`; grade is 1–12; date of birth must be
within the last 99 years and not in the future. Sport is optional; when
present, its name can be any non-empty text up to 100 characters. Passwords
must be 8 to 72 characters with at least one letter and one number. Learner
and coach school records use the same case-insensitive `schools` table.

Optional: `school.province` and `school.town` say where the school is (see Schools for the provinces).

Learner response `201`:

```json
{ "userId": 1 }
```

No access or refresh token is issued until the email is verified. Learner
accounts can log in after verification.

### POST /api/auth/register/coach

Creates a coach, their single team, and any new school or sport in one
transaction. The email must be verified before login is allowed. School and
sport names are trimmed and matched case-insensitively; `Soccer` resolves to
the canonical `Football` sport.

```json
{
  "firstName": "Thabo",
  "lastName": "Williams",
  "dateOfBirth": "1988-04-12",
  "gender": "male",
  "school": "Greenwood High",
  "coachingRole": "head_coach",
  "experience": "5_10_years",
  "team": {
    "name": "Basketball Boys",
    "level": "1st_team",
    "sport": "Basketball"
  },
  "email": "coach@school.com",
  "password": "Passw0rdOK"
}
```

Allowed `coachingRole` values are `head_coach`, `assistant_coach`,
`fitness_coach`, and `team_manager`. Allowed `experience` values are
`less_than_1_year`, `1_3_years`, `3_5_years`, `5_10_years`, and
`10_plus_years`. Allowed team levels are `u13`, `u14`, `u15`, `u16`, `u17`,
`u19`, `1st_team`, and `2nd_team`. The sport is free text up to 40 characters.
Password length is 8–72 characters.

Optional: `schoolProvince` (one of the provinces listed under Schools) and `schoolTown` say where the school is.

Response `201`: `{ "userId": 42, "status": "pending_verification" }`.
The backend sends a six-digit code by email. Duplicate email returns `409
EMAIL_TAKEN`; invalid fields return `422`, for example:
`{ "errors": { "team.sport": "Required" } }`.

### POST /api/auth/verify-otp

Body: `{ "email": "coach@school.com", "code": "123456" }`. The code must be
six numeric digits, expires after 10 minutes, and allows at most five incorrect
attempts. `otp` is accepted as a legacy alias for `code`.

Coach response `200` automatically signs in the verified coach:

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "user": {
    "id": 42,
    "role": "coach",
    "firstName": "Thabo",
    "team": {
      "id": 10,
      "name": "Basketball Boys",
      "level": "1st_team",
      "sport": { "id": 2, "name": "Basketball" },
      "school": { "id": 1, "name": "Greenwood High" }
    }
  }
}
```

For legacy registrations, response remains
`{ "message": "Account verified. You can now log in." }`.

### POST /api/auth/resend-otp

Body: `{ "email": "coach@school.com" }`. Successful response `200`:
`{ "retryAfterSeconds": 60 }`. An email with no pending verification returns
`{ "retryAfterSeconds": 0 }`. Resends are limited to one per email every 60
seconds; a request during the cooldown returns `429` with a `Retry-After`
header.

### POST /api/auth/login

Body: `{ "email": "...", "password": "..." }`. Response `200`: user plus access
and refresh tokens. Coach users include `user.role` and `user.team` (also
available under `user.profile.team`). Unverified accounts receive
`403 EMAIL_NOT_VERIFIED` and must complete email verification first.

### POST /api/auth/refresh

Body: `{ "refreshToken": "..." }`. Response `200`: `{ user, accessToken, refreshToken }` (new pair).

### POST /api/auth/logout

Body: `{ "refreshToken": "..." }`. Response `200`: `{ "message": "Logged out" }`.

### GET /api/auth/me (protected)

Response `200`: `{ "user": { ... } }` (same user object as register, including `profile`).

## Schools

Schools are created automatically from signup (by name, ignoring case). Provinces are exactly:
Eastern Cape, Free State, Gauteng, KwaZulu-Natal, Limpopo, Mpumalanga, North West, Northern Cape, Western Cape.

School object: `{ "id": 1, "name": "Northview High", "province": "Gauteng", "town": "Sandton", "teamCount": 4, "sports": ["Basketball", "Football"] }`.
`province` and `town` are `null` when unknown.

### GET /api/schools (public)

Filters: `province`, `q` (name search), `limit` (max 100), `offset`. Response: `{ "schools": [...], "limit", "offset" }`.

### GET /api/schools/:id (public)

Response: `{ "school": {...} }`, or `404`.

### PATCH /api/schools/:id (admin, or a coach with a team at the school)

Body: `{ "province": "Gauteng", "town": "Sandton" }`. Send only what changes; `null` clears a field.
A signup never overwrites a province or town that is already set. Another school's coach gets `403`.

## Teams, competitions and fixtures

All of these need `Authorization: Bearer <accessToken>`. A **team** is one sport at one school, with a level
(`Varsity`, `U16`, `1st Team`) and a category (`boys`, `girls`, `mixed`). Build the label the screens show,
e.g. "Boys U19 Soccer", from `genderCategory` + `level` + `sport.name`.
Each coach owns at most one team, and `teams.coach_id` stores the coach's user ID.

Lists accept `limit` (default 50, max 100) and `offset`.

### Team object

```json
{ "id": 4, "name": "Basketball Boys", "level": "Varsity", "genderCategory": "boys",
  "sport": { "id": 2, "name": "Basketball" },
  "school": { "id": 1, "name": "Jeppe High", "province": "Gauteng", "town": "Sandton" },
  "coach": { "id": 7, "name": "Sipho Williams" }, "description": null, "location": null, "foundedYear": null,
  "playerCount": 12, "ageGroup": "Open", "favorite": false }
```

`school.province` and `school.town` are `null` until someone sets them. `coach.id` is the coach's **user id**. `sport`, `school` and `coach` are `null` when not set.
`ageGroup` is worked out from `level`:
- `u13`–`u14` → `U/14`
- `u15`–`u16` → `U/16`
- `u17`–`u19` → `U/19`
- anything else (`1st_team`, `Varsity`, none) → `Open`

`favorite` (on `GET /api/teams` and `GET /api/teams/:id`) says whether the signed-in person has favourited the
team; it is always `false` without a token.

### GET /api/teams

Filters:
- `sportId` and `schoolId`
- `q`: part of the team's **or its school's** name, any case
- `mine=true`: teams I coach
- `favorites=true`: my favourite teams
- `favorites=false`: every team except my favourites

`favorites` needs a login.

For the Favourite Teams screen, call `?favorites=true` for "Your teams" and `?favorites=false&q=&sportId=` for
"Add teams". Each row's "Football · U/19 · Gauteng" line is `sport.name · ageGroup · school.province`.
Response: `{ "teams": [...], "limit": 50, "offset": 0 }`.

### GET /api/teams/:id

Response: `{ "team": {...} }`. `404 NOT_FOUND` if missing.

### POST /api/teams (coach or admin)

```json
{ "name": "Basketball Boys", "sportId": 2, "school": "Jeppe High", "level": "Varsity", "genderCategory": "boys" }
```

Only `name` is required. A coach's new team is assigned to that coach, and the school defaults to the coach's school.
`school` is a name (matched ignoring case, created if new). Response `201`: `{ "team": {...} }`.

### PATCH /api/teams/:id (the team's coach, or admin)

Send only the fields to change; send `null` to clear one. `403 FORBIDDEN` for another coach's team.

### GET /api/competitions

The learner Competitions screen. Public; send a token to get `following` for that person.

| Parameter | Meaning |
|---|---|
| `status` | `ongoing`, `upcoming` or `completed`: the status tabs (leave out for All) |
| `sportId` | The sport chips |
| `region` | A province or `National` |
| `q` | Part of the name, any case |
| `following=true` | Only competitions the signed-in person follows (`401` without a token) |

```json
{
  "counts": { "all": 7, "ongoing": 6, "upcoming": 0, "completed": 1 },
  "competitions": [{
    "id": 3, "name": "Schools League 2026 - Football", "season": "2026",
    "sport": { "id": 4, "name": "Football" },
    "status": "ongoing", "region": "National", "ageGroup": "Open",
    "startDate": "2026-09-14", "endDate": "2026-11-28",
    "teams": 7, "roundsPlayed": 4, "totalRounds": 6,
    "leader": { "name": "Oakridge High", "points": 9, "decidedBy": "table",
                "team": { "id": 12, "name": "Oakridge Football", "level": "1st_team", "genderCategory": "boys", "ageGroup": "Open" },
                "school": { "id": 5, "name": "Oakridge High", "province": "Western Cape", "town": "Stellenbosch" } },
    "following": false
  }]
}
```

- `counts` uses every filter except `status`, so each tab can show its number.
- Order: ongoing (earliest start first), upcoming (soonest first), completed (latest end first).
- `status`:
  - `completed` once every fixture is played and any end date the organiser set has passed.
  - `ongoing` once a match is played or live, or the start date has come.
  - `upcoming` before that.
  - Cancelled fixtures are ignored.
- `region`, `ageGroup`, `startDate`/`endDate` and `totalRounds` use what the organiser set. Otherwise they are worked out from the fixtures:
  - Region: the schools' province, or `National` when they come from more than one.
  - Age group: the teams' age group, when they all share one (`null` if mixed).
  - Dates: the first and last match day.
  - Rounds: the most fixtures any one team has.
- `roundsPlayed` follows the share of fixtures played ("Round 4 of 6" and the progress bar). It never reaches the last round while matches are still to come.
- `leader` is `null` until there is a result, and always `null` for upcoming competitions.
  - Ongoing competitions show the table leader ("LEADER").
  - Completed ones show the champion ("CHAMPION"): the winner of a decided `championship` fixture (`decidedBy: "final"`, `points: null`), otherwise the top of the table.
  - `name` is the school name, or the team name for a team with no school.

### GET /api/competitions/:id

One card, same shape: `{ "competition": {...} }`. `404 NOT_FOUND` if it doesn't exist.

### PUT /api/competitions/:id/follow and DELETE /api/competitions/:id/follow (signed in)

Follow a competition to turn its alerts on, or unfollow to turn them off. Both are safe to repeat.
Response: `{ "competitionId": 3, "following": true }`.

### POST /api/competitions (coach or admin)

Body: `{ "name": "...", "sportId": 2, "season": "2026" }` (only `name` required), plus the optional card
details `region` (a province or `National`), `ageGroup` (`U/14`, `U/16`, `U/19`, `Open`), `startDate`,
`endDate` (YYYY-MM-DD) and `rounds` (1 to 500). Response `201`: `{ "competition": {...} }`, the full card.
`409 COMPETITION_EXISTS` if the name already exists (any case).

### PATCH /api/competitions/:id (the coach who created it, or admin)

Same fields as POST; send only those to change. Send `null` to clear a detail so it is worked out from
the fixtures again. `403 FORBIDDEN` for someone else's competition; `400 INVALID_DATES` if the end date
would fall before the start date.

### Fixture object

```json
{
  "id": 10,
  "matchDate": "2026-11-06T16:00:00.000Z",
  "status": "scheduled",
  "venue": "Main Gym",
  "matchType": "league",
  "competition": { "id": 1, "name": "Gauteng Schools Basketball League" },
  "sport": { "id": 2, "name": "Basketball" },
  "homeTeam": { "id": 4, "name": "Basketball Boys", "level": "Varsity", "genderCategory": "boys",
                "sport": { "id": 2, "name": "Basketball" }, "school": { "id": 1, "name": "Jeppe High" } },
  "awayTeam": { "id": 5, "name": "Greenwood Boys", "level": "Varsity", "genderCategory": "boys",
                "sport": { "id": 2, "name": "Basketball" }, "school": { "id": 3, "name": "Greenwood" } },
  "score": null,
  "winner": null,
  "reportFiled": false,
  "lineupSubmitted": { "home": false, "away": false }
}
```

- `winner` is `"home"`, `"away"` or `"draw"` once the fixture is finished with a score, otherwise `null`.
- `reportFiled` is `true` once a match report exists (see Results, standings and reports).
- `lineupSubmitted` says whether each team has submitted its lineup (see Match lineups).
- `matchDate` is always UTC (ends in `Z`). Convert to local time in the app.
- `status`: `scheduled`, `live`, `finished`, `cancelled` or `postponed`. The app's "Today" label is worked out from `matchDate`.
- `matchType`: `league`, `semifinal`, `championship` or `friendly`.
- `score` is `null` until a score exists, then `{ "home": 68, "away": 54 }`.
- `competition` is `null` for friendlies. To know if a team played at home, compare its id with `homeTeam.id`.

### GET /api/fixtures

| Filter | Meaning |
|---|---|
| `when=upcoming` | Not played yet: status scheduled, live or postponed. Soonest first |
| `when=past` | Played: status finished. Newest first |
| `teamId` | Fixtures where the team is home or away |
| `mine=true` | Fixtures for teams I coach (empty for learners for now) |
| `favorites=true` | My feed: matches with one of my favourite teams or in one of my favourite sports. With no favourites picked, every match (the screen's "With none picked, your feed shows every sport") |
| `sportId`, `competitionId`, `status` | Exact filters |
| `from`, `to` | ISO date-times that bound `matchDate` |
| `order=asc` or `order=desc` | Overrides the default order |

Response: `{ "fixtures": [...], "limit": 50, "offset": 0 }`.

### GET /api/fixtures/:id

Response: `{ "fixture": {...} }`. `404 NOT_FOUND` if missing.

### POST /api/fixtures (coach or admin)

```json
{ "homeTeamId": 4, "awayTeamId": 5, "matchDate": "2026-11-06T18:00:00+02:00", "venue": "Main Gym",
  "competitionId": 1, "matchType": "league" }
```

- `homeTeamId`, `awayTeamId` and `matchDate` are required. **`matchDate` must include a time zone** (`+02:00` or `Z`).
- The caller must coach the **home** team (admins can schedule any fixture), otherwise `403 FORBIDDEN`.
- Errors: `SAME_TEAM` (a team cannot play itself), `SPORT_MISMATCH` (both teams must play the same sport),
  `UNKNOWN_COMPETITION`, and `404` for an unknown team.
- Response `201`: `{ "fixture": {...} }`.

### PATCH /api/fixtures/:id (home team's coach, or admin)

Edit `matchDate`, `venue`, `competitionId`, `matchType`, or set `status` to `scheduled`, `postponed` or `cancelled`
(this is the app's "Cancel fixture" action). Send only what changes; `null` clears `competitionId`.
`live` and `finished` cannot be set here; they come from match scoring.
A live or finished fixture returns `409 FIXTURE_LOCKED`.

## Results, standings and reports

All need `Authorization: Bearer <accessToken>`. Results are listed with the normal fixtures list:
`GET /api/fixtures?when=past` returns finished fixtures, newest first, each with `score` and `winner`
(filter with `competitionId`, `teamId`, `sportId` or `mine=true`).

### PUT /api/fixtures/:id/result (home team's coach, or admin)

Records the final score and marks the fixture `finished`. Calling it again corrects the score.

```json
{ "homeScore": 68, "awayScore": 54 }
```

Both scores are whole numbers from 0 to 999. Response `200`: `{ "fixture": {...} }` with `status: "finished"`,
`score` and `winner`.

Errors: `FIXTURE_NOT_STARTED` (the match time has not come yet), `FIXTURE_NOT_PLAYABLE` (the fixture is
cancelled or postponed), `403 FORBIDDEN` (not the home team's coach), `404 NOT_FOUND`.

### GET /api/competitions/:id/standings

The league table, worked out from finished fixtures. Every team with a fixture in the competition appears, even
before it has played (cancelled fixtures do not count).

```json
{
  "competition": { "id": 1, "name": "Schools League", "season": "2026", "sport": { "id": 2, "name": "Basketball" } },
  "standings": [
    { "position": 1,
      "team": { "id": 6, "name": "Charlie Boys", "level": "1st_team", "genderCategory": null,
                "sport": { "id": 2, "name": "Basketball" }, "school": { "id": 3, "name": "Charlie High" } },
      "played": 2, "won": 1, "drawn": 1, "lost": 0,
      "pointsFor": 105, "pointsAgainst": 95, "difference": 10, "points": 4,
      "winRate": 50, "averageScored": 52.5, "averageConceded": 47.5,
      "form": ["D", "W"] }
  ]
}
```

- Points: win 3, draw 1, loss 0.
- Order: points, then `difference` (`pointsFor` minus `pointsAgainst`), then `pointsFor`, then team name.
  Teams level on all of those share a `position`.
- `form` is the last five results, oldest first (`W`, `D` or `L`).
- `404 NOT_FOUND` for an unknown competition. A competition with no fixtures returns `"standings": []`.

### GET /api/teams/:id/record

A team's record from its finished fixtures. Optional filter: `?competitionId=`. Feeds the coach season summary
(record, win rate, average scored and conceded, form) and the coach dashboard win rate.

```json
{ "team": {...},
  "record": { "played": 2, "won": 1, "drawn": 0, "lost": 1, "pointsFor": 110, "pointsAgainst": 110,
              "difference": 0, "points": 3, "winRate": 50, "averageScored": 55, "averageConceded": 55,
              "form": ["W", "L"] } }
```

`winRate` (percent), `averageScored` and `averageConceded` are `null` until the team has played.

### PUT /api/fixtures/:id/report (either team's coach, or admin)

Files the match report, or replaces it. There is one report per fixture, shared by both coaches.

```json
{ "summary": "Alpha won 70-60 after a strong fourth quarter." }
```

`summary` is required (max 5000 characters). Response `200`:

```json
{ "report": { "summary": "...", "author": { "id": 7, "name": "Sipho Williams" },
              "createdAt": "2026-11-02T18:30:00.000Z", "updatedAt": "2026-11-02T18:30:00.000Z" } }
```

Error `FIXTURE_NOT_FINISHED` if the result has not been recorded yet.

### GET /api/fixtures/:id/report

Response `200`: `{ "report": {...} }` (same shape). `404 REPORT_NOT_FOUND` if none has been filed.

## Results screen

Public, no login needed. Everything the learner **Results** tab shows, so the app does not have to group,
count or rank anything itself. Days, `today` and the period tabs use **South African time**: a match at
00:30 on Saturday in Johannesburg is a Saturday result even though it was still Friday in UTC.

### GET /api/results

| Filter | Meaning |
|---|---|
| `q` | Search team name, school name or venue (any case, up to 100 characters) |
| `sportId` | One sport (the chips) |
| `province` | One of the 9 provinces (the filter sheet's region). A match counts when either school is there |
| `period` | `all` (default), `today`, `yesterday`, `week` (since Monday) or `month` (the tabs) |
| `from`, `to` | `YYYY-MM-DD`, both included (the filter sheet's date range) |
| `limit` | Days per page, default 3, max 31 (the screen shows 3 days, then "Load more results") |
| `offset` | Days to skip: send `offset + limit` for the next page |

Only finished matches with a score are results. Response:

```json
{
  "today": "2026-11-09",
  "summary": { "matchesPlayed": 43, "homeWins": 23, "awayWins": 16, "draws": 4, "totalScored": 2942 },
  "days": [
    { "date": "2026-11-05", "isToday": false, "count": 2,
      "results": [ { "...": "a fixture object", "category": "Rugby 1st Team" } ] }
  ],
  "limit": 3, "offset": 0, "totalDays": 18, "hasMore": true
}
```

- `summary` feeds the Results Summary card and covers **every** matching result, not just this page.
  `totalScored` is the "Points & goals scored" tile.
- `days` are newest first and feed the day cards (`count` is the "2 RESULTS" label). Results in a day are newest first.
- Each result is the normal fixture object (see Fixture object) plus `category`, the card label:
  "Football U/19", "Girls Netball 1st Team". Girls' teams are prefixed; levels read `U/16`, `1st Team`, `2nd Team`.
- Show schools as `homeTeam.school.name` and `awayTeam.school.name`. `venue` may be `null`.
- `hasMore` says whether to show "Load more results". `matchesPlayed: 0` with empty `days` means nothing matches.

### GET /api/results/filters

The options for the sport chips and the filter sheet: only sports and provinces that have results.

```json
{ "sports": [{ "id": 4, "name": "Football" }], "provinces": ["Gauteng", "Western Cape"],
  "periods": ["all", "today", "yesterday", "week", "month"] }
```

### GET /api/results/standings

The Top Standings card: a table of **schools** from every finished result. Filters: `sportId`, `province`, and
`limit` (1 to 100; leave it out for the full table). Use `limit=5` for the card and no limit for "Full standings".

```json
{
  "sport": null, "province": null, "totalSchools": 8,
  "standings": [
    { "position": 1, "school": { "id": 2, "name": "Riverside College", "province": "Gauteng", "town": "Pretoria" },
      "played": 19, "won": 11, "drawn": 2, "lost": 6, "pointsFor": 640, "pointsAgainst": 590,
      "difference": 50, "points": 35, "winRate": 57.9, "averageScored": 33.7, "averageConceded": 31.1,
      "form": ["W", "W", "L", "D", "L"] }
  ]
}
```

- Same rules as league tables: win 3, draw 1, loss 0; ordered by points, then difference, then points for.
  Schools level on all of those share a `position`. `form` is the last five results, oldest first.
- A school's teams count together. Matches between two teams of the same school are left out.
- With `province`, only that province's schools are listed and numbered from 1, but all their matches count,
  including those against schools elsewhere.
- For one competition's league table, use `GET /api/competitions/:id/standings` instead.

## Rankings screen

Public endpoints for the learner app's Rankings screen. Rankings cover one **season** (a calendar year in
South African time, the current one by default) and are worked out from its finished results each time.

### How points are earned

Every finished match is worth up to 100 points to each team, split like the screen's "Ranking breakdown" card:

| Part | Max | How |
|---|---|---|
| Match Wins | 40 | Win 40, draw 20, loss 0 |
| Strength of Opposition | 25 | 25 × the opponent's season record (wins plus half the draws, over matches played) |
| Goals Scored | 20 | 20 × the team's share of the match score (0–0 gives each side 10) |
| Consistency | 10 | 10 when unbeaten in this match **and** the team's previous one |
| Participation | 5 | 5 for every match played |

- **Teams**: the sum over their matches, so playing and winning more both count.
- **Schools**: the sum of their teams.
- **Regions** (provinces): the **average** of their schools, so a big province doesn't win just by being big.
- **Athletes**: their team's match points for every match they were in the lineup for; bench players get half.
  There are no individual stats (goals, tries) yet, so lineups are the only measure. Athletes appear only once
  coaches submit lineups.

Every row has `breakdown` with the points from each part (rounded, so it may be 1 off `points`).

### GET /api/rankings

| Parameter | Meaning |
|---|---|
| `type` | `schools` (default), `teams`, `athletes` or `regions`: the tabs |
| `sportId` | Only matches in this sport count (the sport chips) |
| `ageGroup` | `U/14`, `U/16`, `U/19` or `Open` (send as `U%2F14`). Only teams in that group count. Levels map as: u13–u14 → U/14, u15–u16 → U/16, u17–u19 → U/19, anything else (`1st_team`, `2nd_team`, none) → Open |
| `province` | Only entries in this province are listed, numbered from 1 (the region filter and "View top 10" on a region card) |
| `season` | Year, default the current one |
| `limit`, `offset` | Paging, default 10 rows ("View full rankings": `limit=100`, or page with `offset`) |

```json
{
  "type": "schools", "season": 2026, "updatedAt": "2026-11-09T17:15:24.331Z",
  "filters": { "sport": null, "ageGroup": null, "province": null },
  "total": 8, "limit": 10, "offset": 0, "hasMore": false,
  "rankings": [
    { "position": 1, "previousPosition": 3, "trend": 2,
      "name": "Riverside College", "detail": "4 sports played", "province": "Gauteng", "points": 1074,
      "played": 19, "won": 11, "drawn": 2, "lost": 6,
      "breakdown": { "wins": 480, "opposition": 209, "scoring": 209, "consistency": 80, "participation": 95 },
      "school": { "id": 2, "name": "Riverside College", "province": "Gauteng", "town": "Pretoria" },
      "sportsPlayed": 4, "teamsRanked": 4 }
  ]
}
```

- `name`, `detail` and `province` are the row's two lines: the school name; for a team, its school name and a
  label like `"Rugby 1st Team"` or `"Girls Netball U/16"`; for an athlete, their name and `"School · Sport"`;
  for a region, the province and `"3 schools"`.
- Each type adds its own references: `school` and `sportsPlayed`/`teamsRanked` (schools); `team` (with
  `ageGroup`), `school`, `sport` (teams); `athlete` (`id`, `name`), `team`, `school`, `sport` (athletes);
  `schoolsRanked` (regions).
- `trend` is places moved since the ranking 7 days ago: positive is up, negative down, `0` unchanged.
  `previousPosition` and `trend` are `null` for an entry that wasn't ranked then (show it as new).
- Entries on equal points share a `position`. `updatedAt` is when the latest result was recorded (for
  "Updated 9 Nov 2026"), `null` if the season has none.

### GET /api/rankings/overview

The cards under the table, for the whole season (no filters except `season`):

```json
{
  "season": 2026, "updatedAt": "2026-11-09T17:15:24.331Z",
  "breakdown": [{ "key": "wins", "label": "Match Wins", "weight": 0.4, "description": "A win earns 40 points and a draw 20." }],
  "topSports": [{ "sport": { "id": 7, "name": "Rugby" }, "label": "Rugby 1st Team", "team": {}, "school": {}, "points": 302 }],
  "topRisers": [{ "position": 4, "name": "Lakeside Collegiate", "trend": 2 }],
  "regionLeaders": [{ "province": "Gauteng", "leader": { "position": 1, "name": "Riverside College", "points": 1074 } }]
}
```

- `breakdown`: the "Ranking breakdown" card (weights add up to 1).
- `topSports`: each sport's best team, best first, top 5 ("Top performing sports").
- `topRisers`: schools that climbed this week, biggest climb first, top 5 ("Top rise this season").
- `regionLeaders`: the top school in each province that has one ("Top schools by region"). Rows in
  `topRisers` and `leader` have the same shape as a schools ranking row (shortened above).

### GET /api/rankings/filters

```json
{ "season": 2026, "seasons": [2026], "types": ["schools", "teams", "athletes", "regions"],
  "sports": [{ "id": 4, "name": "Football" }], "ageGroups": ["U/14", "U/16", "U/19", "Open"],
  "provinces": ["Gauteng", "Western Cape"] }
```

`sports` and `provinces` only list those with results in the season; `seasons` lists every year with results.

## Team rosters

All need `Authorization: Bearer <accessToken>`. A learner joins a team in one of two ways: they **ask to join**
and the team's coach approves, or the coach **adds** them directly. A learner can be on several teams.

**Privacy.** Players are school children. A roster is visible only to the team's coach, admins and the team's own
active players. Everyone else only sees `playerCount` on the team. A learner with a pending request cannot see the roster.

Member object:

```json
{ "userId": 12, "name": "Lena One", "firstName": "Lena", "lastName": "One",
  "status": "active", "jerseyNumber": 7, "position": "Guard",
  "grade": 9, "className": "9A", "joinedAt": "2026-11-03T08:00:00.000Z", "requestedAt": "2026-11-02T15:10:00.000Z" }
```

`status` is `pending` (asked to join) or `active` (on the team). `jerseyNumber` is 0 to 999 and unique among a
team's active players. `position` is free text (up to 50 characters) because it differs by sport.

### GET /api/teams/:id/roster

The team's coach, admins and active players. Optional `?status=pending` lists join requests (coach and admin only).
Ordered by jersey number, then name. Response:
`{ "team": { "id", "name" }, "status": "active", "count": 3, "roster": [ member, ... ] }`.
`403 FORBIDDEN` for anyone else.

### POST /api/teams/:id/join-requests (learners)

A learner asks to join. Optional body: `{ "jerseyNumber": 7 }` (the number they would like).
Response `201`: `{ "member": {...} }` with `status: "pending"`.
Errors: `REQUEST_PENDING`, `ALREADY_MEMBER` (both `409`), `403` for coaches and admins, `404` for an unknown team.

### DELETE /api/teams/:id/membership

Leave a team, or cancel your own pending request. `404` if you are not on the team.

### GET /api/me/teams

The teams I am on and the ones I have asked to join:

```json
{ "teams": [ { "status": "active", "jerseyNumber": 7, "position": "Guard", "joinedAt": "...", "requestedAt": "...",
               "team": { "id": 4, "name": "Alpha Boys", "level": "1st_team", "sport": {...}, "school": {...} } } ] }
```

### GET /api/teams/:id/candidates?q= (the team's coach, or admin)

Learners at the **team's school** who could be added: verified accounts that are not already on the team (or
waiting). `q` searches by name. Each candidate:

```json
{ "userId": 15, "name": "Noah Three", "grade": 9, "className": "9A",
  "declaredSport": "Basketball", "declaredTeamName": "Alpha Boys", "declaredJerseyNumber": 3 }
```

`declared...` is what the learner chose at signup. `409 TEAM_SCHOOL_REQUIRED` if the team has no school.

### POST /api/teams/:id/roster (the team's coach, or admin)

Adds a learner straight onto the team, or approves their pending request.

```json
{ "userId": 15, "jerseyNumber": 3, "position": "Centre" }
```

Only `userId` is required. Response `201` (added) or `200` (a pending request was approved): `{ "member": {...} }`.
Errors: `NOT_A_LEARNER` (400), `ALREADY_MEMBER`, `JERSEY_TAKEN`, `SCHOOL_MISMATCH` (coaches can only add learners
from the team's school; admins can add anyone) (all 409), `404` for an unknown user.

### PATCH /api/teams/:id/roster/:userId (the team's coach, or admin)

Approve a request (`"status": "active"`), or change `jerseyNumber` / `position`. Send only what changes; `null`
clears a jersey number. `409 JERSEY_TAKEN` if another active player has the number. `404` if the learner is not on the team.

### DELETE /api/teams/:id/roster/:userId (the team's coach, or admin)

Removes a player, or rejects a join request.

### Team object

Every team now includes `"playerCount"`: the number of active players. It is visible to everyone and feeds the
coach home "Total players" card.

## Favourites

A signed-in person's favourite sports and teams. They shape the feed (`GET /api/fixtures?favorites=true`).
Followed competitions (`PUT /api/competitions/:id/follow`) come back here too.

### GET /api/sports/categories (public)

The Favourite Sports screen's tiles, grouped and in screen order:

```json
{ "categories": [
  { "key": "team", "label": "Team Sports", "sports": [
    { "id": 4, "name": "Football", "key": "football", "category": "team" },
    { "id": 23, "name": "Water Polo", "key": "waterPolo", "category": "team" } ] },
  { "key": "other", "label": "Other", "sports": [{ "id": 50, "name": "Kabaddi", "key": null, "category": "other" }] }
] }
```

- `key` is the id the app already saves (`football`, `waterPolo`, `indigenousGames`).
- Groups: `team`, `athletics`, `racket`, `water`, `combat`, `precision`, `mind`. Sports typed in at signup land in `other`, with `key: null`.
- `GET /api/sports` (A to Z) now includes `key` and `category` too.

### GET /api/me/favorites

```json
{ "sports": [{ "id": 6, "name": "Netball", "key": "netball", "category": "team" }],
  "teams": [{ "id": 4, "name": "Basketball Boys", "favorite": true }],
  "competitions": [{ "id": 3, "name": "Schools League 2026 - Football", "sport": { "id": 4, "name": "Football" } }] }
```

`teams` are full team objects (shortened above). Sports come in screen order; teams and competitions A to Z.

### PUT /api/me/favorites/sports/:sport and DELETE /api/me/favorites/sports/:sport

Pick or unpick one tile. `:sport` is the sport's `id` or its app `key` (any case).
Response: `{ "sport": {...}, "favorite": true }`. Both are safe to repeat. `404 NOT_FOUND` for an unknown sport.

### PUT /api/me/favorites/sports

Replace the whole list in one go: `{ "sports": ["football", "waterPolo", 7] }` (ids or keys).
An empty list clears it. `400 UNKNOWN_SPORT` (with `details.sports`) if any is unknown; nothing changes then.
Response: the same as `GET /api/me/favorites`.

### PUT /api/me/favorites/teams/:teamId and DELETE /api/me/favorites/teams/:teamId

Favourite or unfavourite a team. Response: `{ "teamId": 4, "favorite": true }`. Both are safe to repeat.
`404 NOT_FOUND` for an unknown team. List them with `GET /api/teams?favorites=true` or `GET /api/me/favorites`.

## Match lineups

All need `Authorization: Bearer <accessToken>`. Each of the two teams in a fixture submits its own lineup: the
starters and the bench. Players must be **active members of that team's roster** (see Team rosters). The jersey
number and position are copied from the roster when the lineup is submitted, so the match sheet stays correct even
if the roster changes later. Fixtures include `"lineupSubmitted": { "home": true, "away": false }`, which feeds
the coach home "Submit match lineup" action.

**Privacy.** Before kick-off a lineup is visible only to that team's coach, admins and the team's active players.
Once the fixture is `live` or `finished` both lineups are public. Everyone can see that a lineup was submitted.

Lineup object:

```json
{ "team": { "id": 4, "name": "Alpha Boys" }, "formation": "4-4-2",
  "starters": [ { "userId": 12, "name": "Pat Player", "jerseyNumber": 4, "position": "Guard" } ],
  "bench":    [ { "userId": 14, "name": "Rae Player", "jerseyNumber": 12, "position": null } ],
  "submittedAt": "2026-11-07T08:00:00.000Z", "updatedAt": "2026-11-07T08:00:00.000Z" }
```

### GET /api/fixtures/:id/lineups

```json
{ "fixtureId": 9, "public": false,
  "home": { "teamId": 4, "submitted": true,  "lineup": { ... } },
  "away": { "teamId": 5, "submitted": true,  "lineup": null } }
```

`lineup` is `null` when nothing was submitted, or when the caller is not allowed to see it yet.

### PUT /api/fixtures/:id/lineups/:teamId (the team's coach, or admin)

Submits the lineup, or replaces the one already there.

```json
{ "formation": "4-4-2",
  "starters": [ { "userId": 12 }, { "userId": 13, "position": "Wing" } ],
  "bench": [ { "userId": 14 } ] }
```

`starters` (1 to 25) is required. `formation` (max 30 characters), `bench` (max 25) and `position` (max 50) are
optional. A `position` given here overrides the roster one for this match. Response `200`: `{ "lineup": {...} }`.

| Status | Code | Meaning |
|---|---|---|
| 400 | `TEAM_NOT_IN_FIXTURE` | `:teamId` is not one of the two teams |
| 403 | `FORBIDDEN` | Not that team's coach (the opposing coach is also refused) |
| 409 | `FIXTURE_CLOSED` | The fixture is finished or cancelled |
| 422 | `NOT_ON_TEAM` | A player is not an active member of the team. `error.details.userIds` lists them |
| 422 | `DUPLICATE_PLAYER` | A player appears twice (including starter and bench) |

### DELETE /api/fixtures/:id/lineups/:teamId (the team's coach, or admin)

Withdraws the lineup. `204` on success, `404 LINEUP_NOT_FOUND` if none was submitted, `409 FIXTURE_CLOSED` as above.

## Coach dashboard

### GET /api/coach/dashboard (coaches only)

The coach's home screen in one request, about the logged-in coach's own team. Admins and learners get `403`;
a coach with no team gets `404 TEAM_NOT_FOUND`.

```json
{
  "team": { "id": 4, "name": "Alpha Boys", "...": "same as the team object" },
  "squadSize": 12,
  "pendingRequests": 2,
  "record": { "played": 5, "won": 3, "drawn": 1, "lost": 1, "winRate": 60, "form": ["W","L","D","W","W"], "...": "see Results" },
  "nextMatch": { "...": "a fixture object, or null" },
  "upcoming": [ { "...": "next 5 scheduled or live fixtures, soonest first" } ],
  "recentResults": [ { "...": "last 5 finished fixtures, newest first" } ],
  "actionItems": [
    { "type": "record_result", "dueAt": "2026-11-05T13:00:00.000Z", "fixture": { "...": "fixture" } },
    { "type": "submit_lineup", "dueAt": "2026-11-09T13:00:00.000Z", "fixture": { "...": "fixture" } },
    { "type": "file_report", "dueAt": "2026-11-01T13:00:00.000Z", "fixture": { "...": "fixture" } },
    { "type": "review_join_requests", "dueAt": null, "count": 2 }
  ]
}
```

`squadSize` counts active players. `record` covers every finished fixture (see Results, standings and reports).
A match stays in `upcoming` until 4 hours after kick-off. Action items, most urgent first:

| `type` | When it appears | Goes away when |
|---|---|---|
| `record_result` | A match **your team hosts** is over (4 hours after kick-off) with no result | You record the result |
| `submit_lineup` | A scheduled match in the next 7 days has no lineup from **your team** | You submit it |
| `file_report` | A match your team played in the last 30 days has no report (either coach can file it) | A report is filed |
| `review_join_requests` | Players are waiting to join (`count`) | You approve or reject them |

Cancelled matches never produce items.

## Protecting a new route (for backend developers)

```js
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/', authenticate, handler);                              // any logged-in user
router.post('/', authenticate, requireRole('admin', 'coach'), handler); // specific roles
// inside handler: req.user = { id, email, first_name, last_name, phone, date_of_birth, gender, role }
```
