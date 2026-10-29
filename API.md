# Sportstures API

Shared reference for the website and mobile app. **Add every new endpoint here.**

Base URL (local): `http://localhost:5000`

All requests and responses are JSON. Protected routes need the header
`Authorization: Bearer <accessToken>`.

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

## Teams, competitions and fixtures

All of these need `Authorization: Bearer <accessToken>`. A **team** is one sport at one school, with a level
(`Varsity`, `U16`, `1st Team`) and a category (`boys`, `girls`, `mixed`). Build the label the screens show,
e.g. "Boys U19 Soccer", from `genderCategory` + `level` + `sport.name`.
Each coach owns at most one team, and `teams.coach_id` stores the coach's user ID.

Lists accept `limit` (default 50, max 100) and `offset`.

### Team object

```json
{ "id": 4, "name": "Basketball Boys", "level": "Varsity", "genderCategory": "boys",
  "sport": { "id": 2, "name": "Basketball" }, "school": { "id": 1, "name": "Jeppe High" },
  "coach": { "id": 7, "name": "Sipho Williams" }, "description": null, "location": null, "foundedYear": null }
```

`coach.id` is the coach's **user id**. `sport`, `school` and `coach` are `null` when not set.

### GET /api/teams

Filters: `sportId`, `schoolId`, `q` (name search), `mine=true` (teams I coach).
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

Filter: `sportId`. Response:

```json
{ "competitions": [{ "id": 1, "name": "Gauteng Schools Basketball League", "season": "2026",
                     "sport": { "id": 2, "name": "Basketball" } }] }
```

### POST /api/competitions (coach or admin)

Body: `{ "name": "...", "sportId": 2, "season": "2026" }` (only `name` required).
`409 COMPETITION_EXISTS` if the name already exists (any case).

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
  "score": null
}
```

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

## Protecting a new route (for backend developers)

```js
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/', authenticate, handler);                              // any logged-in user
router.post('/', authenticate, requireRole('admin', 'coach'), handler); // specific roles
// inside handler: req.user = { id, email, first_name, last_name, phone, date_of_birth, gender, role }
```
