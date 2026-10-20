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
| 409 | `EMAIL_TAKEN` | Email already registered |
| 429 | `TOO_MANY_REQUESTS` | Rate limited (20 register/login attempts per 15 min per IP) |

## Auth

Access tokens last 15 minutes. Refresh tokens last 30 days and are **single use**:
each `/refresh` returns a new pair, so always save the newest `refreshToken`.

Client flow: store both tokens (secure storage on mobile). When a request returns
`TOKEN_EXPIRED`, call `/refresh`, save the new pair and retry once. If `/refresh`
fails, send the user to the login screen.

### POST /api/auth/register

Body:

```json
{ "email": "ada@example.com", "password": "Passw0rdOK", "firstName": "Ada", "lastName": "Obi", "phone": "08012345678" }
```

`email` and `password` are required. Password: 8 to 72 characters with at least one letter and one number.
New accounts always get role `user`.

Response `201`:

```json
{ "user": { "id": 1, "email": "ada@example.com", "first_name": "Ada", "last_name": "Obi", "phone": "08012345678", "role": "user", "created_at": "..." },
  "accessToken": "...", "refreshToken": "..." }
```

### POST /api/auth/login

Body: `{ "email": "...", "password": "..." }`. Response `200`: same shape as register.

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
