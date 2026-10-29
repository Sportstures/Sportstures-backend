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
| 429 | `TOO_MANY_REQUESTS` | Rate limited; resend also returns a `Retry-After` header |

## Auth

Access tokens last 15 minutes. Refresh tokens last 30 days and are **single use**:
each `/refresh` returns a new pair, so always save the newest `refreshToken`.

Client flow: store both tokens (secure storage on mobile). When a request returns
`TOKEN_EXPIRED`, call `/refresh`, save the new pair and retry once. If `/refresh`
fails, send the user to the login screen.

### POST /api/auth/register

Player registration creates an unverified player and emails a six-digit OTP.
Configure `SMTP_HOST` and `SMTP_FROM` (and, when required, `SMTP_USER` and
`SMTP_PASSWORD`) before accepting player registrations. The sport step may be
skipped by sending `sport: null` or omitting the property.

```json
{
  "role": "player",
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

Player registration requires all personal and school fields. Gender is `male`
or `female`; grade is 1–12; date of birth must be within the last 99 years and
not in the future. Sport is optional; when present, its name can be any
non-empty text up to 100 characters. Passwords must be 8 to 72 characters with
at least one letter and one number. Other registration calls that omit `role`
retain the existing generic `user` flow.

Player response `201`:

```json
{ "userId": 1 }
```

No access or refresh token is issued until the email is verified.

### POST /api/auth/verify-otp

Body: `{ "email": "ada@example.com", "otp": "123456" }`.
The OTP must be six numeric digits. Response `200`:
`{ "message": "Account verified. You can now log in." }`.
Verification does not automatically sign the user in.

### POST /api/auth/resend-otp

Body: `{ "email": "ada@example.com" }`. Response `200` uses a generic message
whether or not the address has a pending account. Resends are limited to one
per email every 60 seconds; a limited response is `429` with a `Retry-After`
header. Verification codes allow at most five incorrect attempts.

### Generic registration response

Requests without `role: "player"` preserve the legacy generic `user`
registration response and token issuance. Password rules are the same.

### POST /api/auth/login

Body: `{ "email": "...", "password": "..." }`. Response `200`: same shape as register.
Unverified player accounts receive `403 EMAIL_NOT_VERIFIED` and must complete
email verification first.

### POST /api/auth/refresh

Body: `{ "refreshToken": "..." }`. Response `200`: `{ user, accessToken, refreshToken }` (new pair).

### POST /api/auth/logout

Body: `{ "refreshToken": "..." }`. Response `200`: `{ "message": "Logged out" }`.

### GET /api/auth/me (protected)

Response `200`: `{ "user": { ... } }`.

## Protecting a new route (for backend developers)

```js
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/', authenticate, handler);                              // any logged-in user
router.post('/', authenticate, requireRole('admin', 'coach'), handler); // specific roles
// inside handler: req.user = { id, email, first_name, last_name, phone, role }
```
