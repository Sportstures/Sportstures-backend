# Sportstures Backend

REST API for Sportstures: player and coach signup with email verification, schools and sports,
teams, competitions and fixtures. The website and the mobile app both use it.

**Endpoints:** see [API.md](API.md). Add every new endpoint there.

## Tech stack

- Node.js 18+ and Express 4
- PostgreSQL 16 (managed with pgAdmin)
- JWT access tokens with refresh tokens stored in the database
- Nodemailer over SMTP (Afrihost) for verification emails

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Create your `.env`

```bash
cp .env.example .env
```

Fill in your own values. `.env` is gitignored, so **never put real passwords in this README or
any other committed file.** Generate `JWT_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

See [Environment variables](#environment-variables) for what each one does.

### 3. Set up the database

**Option A: local PostgreSQL and pgAdmin**

1. In pgAdmin, right-click **Databases → Create → Database** and name it `sportstures`.
2. Open **Tools → Query Tool** on that database and run [db/schema.sql](db/schema.sql).
3. Run the migrations in this order. Each one is safe to run more than once.
   1. `db/migrations/001_auth_foundation.sql`
   2. `db/migrations/002_player_signup_verification.sql`
   3. `db/migrations/002_roles_and_signup_profile.sql`
   4. `db/migrations/003_coach_signup.sql`
   5. `db/migrations/003_free_text_player_sport.sql`
   6. `db/migrations/004_teams_competitions_fixtures.sql`
   7. `db/migrations/005_coach_signup_api.sql`

Migration 005 converts existing `teams.coach_id` values from coach profile IDs to user IDs and
enforces one team per coach.

**Option B: Docker**

```bash
docker compose up -d
```

This starts PostgreSQL on port 5432 (loading [db/init.sql](db/init.sql) on first start) and
pgAdmin on http://localhost:5050. It uses `DB_USER`, `DB_PASSWORD` and `DB_NAME` from `.env`.
Then run the migrations above in pgAdmin.

### 4. Start the server

```bash
npm run dev   # auto-reloads on changes
npm start     # production
```

### 5. Check it's running

```bash
curl http://localhost:5000/health
```

```json
{ "message": "Server is running", "timestamp": "..." }
```

To try the auth flow, import [postman/Sportstures-Auth.postman_collection.json](postman/Sportstures-Auth.postman_collection.json)
into Postman.

## Email

Signup sends a one-time code by email, so the server needs a working SMTP account. We use
Afrihost: `mail.sportstures.co.za`, port 465, SSL, logged in as `no-reply@sportstures.co.za`.

Each Sportstures address has one job:

| Address | Used for |
|---------|----------|
| `no-reply@` | Sends OTP and other automated emails (`SMTP_USER` / `SMTP_FROM`) |
| `support@` | Account and app help; replies to automated emails go here |
| `info@` | General enquiries |
| `hello@` | Public contact |
| `partnerships@` | School and business enquiries |
| `privacy@` | Privacy and personal information requests |
| `security@` | Security reports; published at `/.well-known/security.txt` |
| `billing@` | Billing questions |

Email templates live in [src/emails/](src/emails/). [layout.js](src/emails/layout.js) is the
branded shell (green header with the crest, white card, footer) and uses the app's colours. Build
new emails on it like [verificationCode.js](src/emails/verificationCode.js), escape any user data
with `escapeHtml`, and send them with `sendEmail` from [email.js](src/utils/email.js).

The public addresses are the `CONTACT_EMAIL_*` variables. The website and app read them from
`GET /api/contact`, so don't hard-code them.

## Environment variables

| Variable | Example | Purpose |
|----------|---------|---------|
| `PORT` | `5000` | Port the API listens on |
| `NODE_ENV` | `development` | `development` or `production` |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | *(your password)* | Database password |
| `DB_NAME` | `sportstures` | Database name |
| `JWT_SECRET` | *(96-character random hex)* | Signs access tokens. Use a different one in each environment |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | Access token lifetime |
| `JWT_REFRESH_EXPIRES_DAYS` | `30` | Refresh token lifetime in days |
| `AUTH_RATE_LIMIT_MAX` | `200` | Register/login attempts per IP per 15 minutes. Default 20; leave it unset in production |
| `SMTP_HOST` | `mail.sportstures.co.za` | Outgoing mail server |
| `SMTP_PORT` | `465` | 465 for SSL, 587 for STARTTLS |
| `SMTP_SECURE` | `true` | `true` for port 465 |
| `SMTP_USER` | `no-reply@sportstures.co.za` | SMTP login |
| `SMTP_PASSWORD` | *(mailbox password)* | SMTP password |
| `SMTP_FROM` | `Sportstures <no-reply@sportstures.co.za>` | Sender shown on emails |
| `CONTACT_EMAIL_*` | `support@sportstures.co.za` | Public addresses (see [Email](#email)). Optional; defaults to the addresses above |

## Project structure

```
Backend/
├── db/
│   ├── config.js          # PostgreSQL connection pool
│   ├── schema.sql         # Base tables (run first in pgAdmin)
│   ├── init.sql           # Same base tables, loaded automatically by Docker
│   └── migrations/        # Run in order after the base tables
├── postman/               # Postman collection for the auth flow
├── src/
│   ├── server.js          # Express app and route mounting
│   ├── controllers/       # Request handlers (auth)
│   ├── middleware/        # authenticate, requireRole, validation
│   ├── routes/            # auth, contact, sports, teams, competitions, fixtures
│   └── utils/             # email, tokens, contacts, schools, sports, serializers
├── API.md                 # Endpoint reference for the website and app
├── .env.example           # Template for .env
└── docker-compose.yml     # PostgreSQL and pgAdmin
```

## Useful commands

```bash
psql -U postgres -d sportstures -h localhost   # open the database in the terminal
docker compose logs -f postgres                # follow database logs (Docker)
```
