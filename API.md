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
| 409 | `EMAIL_TAKEN` | Email already registered |
| 429 | `TOO_MANY_REQUESTS` | Rate limited (20 register/login attempts per 15 min per IP) |

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
| `coach` | no | Only used when `role` is `coach`: `specialization`, `yearsOfExperience`, `certification`, `bio` |

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

`profile` is `null` when no school or sport was given. For coaches it holds the coach details
(`specialization`, `yearsOfExperience`, `certification`, `bio`).
The mobile "confirm password" field is checked in the app only and is not sent.

### GET /api/sports

Public. Response `200`: `{ "sports": [{ "id": 1, "name": "Athletics" }, ...] }`.
Use this to fill the sport dropdown so the app and website never drift from the backend list.

### POST /api/auth/login

Body: `{ "email": "...", "password": "..." }`. Response `200`: same shape as register.

### POST /api/auth/refresh

Body: `{ "refreshToken": "..." }`. Response `200`: `{ user, accessToken, refreshToken }` (new pair).

### POST /api/auth/logout

Body: `{ "refreshToken": "..." }`. Response `200`: `{ "message": "Logged out" }`.

### GET /api/auth/me (protected)

Response `200`: `{ "user": { ... } }` (same user object as register, including `profile`).

## Protecting a new route (for backend developers)

```js
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/', authenticate, handler);                              // any logged-in user
router.post('/', authenticate, requireRole('admin', 'coach'), handler); // specific roles
// inside handler: req.user = { id, email, first_name, last_name, phone, date_of_birth, gender, role }
```
