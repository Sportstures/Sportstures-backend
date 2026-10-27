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
| 401 | `NO_TOKEN` | No Bearer token sent |
| 401 | `INVALID_TOKEN` | Access token invalid |
| 401 | `TOKEN_EXPIRED` | Access token expired: call `/refresh` and retry |
| 401 | `INVALID_CREDENTIALS` | Wrong email or password |
| 401 | `INVALID_REFRESH_TOKEN` | Refresh token unknown or already used: log in again |
| 401 | `REFRESH_TOKEN_EXPIRED` | Refresh token expired: log in again |
| 403 | `FORBIDDEN` | Logged in but role not allowed |
| 400 | `UNKNOWN_SPORT` | `sport.name` is not in `GET /api/sports` |
| 400 | `SAME_TEAM` / `SPORT_MISMATCH` / `UNKNOWN_COMPETITION` | Fixture rules, see Fixtures |
| 404 | `NOT_FOUND` | No team or fixture with that id |
| 409 | `EMAIL_TAKEN` | Email already registered |
| 409 | `COMPETITION_EXISTS` / `FIXTURE_LOCKED` | Duplicate competition name, or editing a live/finished fixture |
| 429 | `TOO_MANY_REQUESTS` | Rate limited (20 register/login attempts per 15 min per IP, configurable with `AUTH_RATE_LIMIT_MAX`) |

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

One request carries all four signup steps, so the app collects the steps locally and sends once at the end.

```json
{
  "email": "ada@example.com",
  "password": "Passw0rdOK",
  "firstName": "Ada",
  "lastName": "Obi",
  "dateOfBirth": "2009-05-14",
  "gender": "female",
  "role": "learner",
  "school": { "name": "Jeppe High School", "grade": 9, "className": "9B" },
  "sport": { "name": "Netball", "teamName": "Jeppe U15", "jerseyNumber": 7, "level": "U15" }
}
```

| Field | Required | Notes |
|---|---|---|
| `email`, `password` | yes | Password: 8 to 72 characters with a letter and a number |
| `firstName`, `lastName`, `phone` | no | |
| `dateOfBirth` | no | `YYYY-MM-DD` (convert the day/month/year dropdowns), not in the future |
| `gender` | no | `male` or `female` (case-insensitive) |
| `role` | no | `learner` (default) or `coach`. `admin` is rejected |
| `school` | no | `name` (text, created if new, matched ignoring case), `grade` (number 1 to 12, send `9` not `"Grade 9"`), `className` |
| `sport` | no | Skip the whole object if the user skips step 3. `name` must be one from `GET /api/sports`. `jerseyNumber` 0 to 999 |
| `coach` | no | Only used when `role` is `coach`. See "Coach signup" below |

The whole signup is saved together or not at all.

Response `201`:

```json
{
  "user": {
    "id": 1, "email": "ada@example.com", "first_name": "Ada", "last_name": "Obi", "phone": null,
    "date_of_birth": "2009-05-14", "gender": "female", "role": "learner", "created_at": "...",
    "profile": {
      "school": { "id": 1, "name": "Jeppe High School" }, "grade": 9, "className": "9B",
      "sport": { "id": 6, "name": "Netball" }, "teamName": "Jeppe U15", "jerseyNumber": 7, "level": "U15"
    }
  },
  "accessToken": "...", "refreshToken": "..."
}
```

`profile` is `null` when no school or sport was given. For coaches it holds the coach details (below).
The mobile "confirm password" field is checked in the app only and is not sent.

#### Coach signup

Send `"role": "coach"` plus the personal fields above, and a `coach` object from the coach steps
(Coaching, Sports). Every field is optional at the API; the app enforces what is required.

```json
{
  "email": "coach@example.com", "password": "Passw0rdOK", "role": "coach",
  "firstName": "Sipho", "lastName": "Williams", "dateOfBirth": "1985-03-02", "gender": "male",
  "coach": {
    "school": "Jeppe High School",
    "teamName": "Basketball Boys",
    "teamLevel": "1st Team",
    "coachingRole": "Head Coach",
    "experience": "5 - 10 years",
    "sports": ["Basketball", "Swimming"]
  }
}
```

- `school` is a plain string (matched ignoring case, created if new).
- `teamLevel`, `coachingRole` and `experience` are stored exactly as sent (the dropdown text), so a new dropdown option needs no backend change.
- `sports` is a list of names from `GET /api/sports`; duplicates are ignored and an unknown name returns `UNKNOWN_SPORT`.

The coach `profile` in the response:

```json
{ "school": { "id": 1, "name": "Jeppe High School" }, "teamName": "Basketball Boys", "teamLevel": "1st Team",
  "coachingRole": "Head Coach", "experience": "5 - 10 years",
  "sports": [{ "id": 2, "name": "Basketball" }, { "id": 10, "name": "Swimming" }] }
```

### GET /api/sports

Public. Response `200`: `{ "sports": [{ "id": 1, "name": "Athletics" }, ...] }`. It currently has 10 sports:
Athletics, Basketball, Cricket, Football, Hockey, Netball, Rugby, Swimming, Tennis, Volleyball.
Use this to fill the sport dropdowns (learner and coach) so the app and website never drift from the backend list.
The learner signup list in the app has no Swimming and the coach list has no Tennis or Volleyball, so both
should load from this endpoint.

### POST /api/auth/login

Body: `{ "email": "...", "password": "..." }`. Response `200`: same shape as register.

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
