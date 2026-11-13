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
   8. `db/migrations/006_match_reports.sql`
   9. `db/migrations/007_team_members.sql`
   10. `db/migrations/008_match_lineups.sql`
   11. `db/migrations/009_school_location.sql`
   12. `db/migrations/010_competition_details.sql`
   13. `db/migrations/011_favourites.sql`

Migration 005 converts existing `teams.coach_id` values from coach profile IDs to user IDs and
enforces one team per coach.

**Option B: Docker**

```bash
docker compose up -d
```

This starts PostgreSQL on port 5432 (loading [db/init.sql](db/init.sql) on first start) and
pgAdmin on http://localhost:5050. It uses `DB_USER`, `DB_PASSWORD` and `DB_NAME` from `.env`.
Then run the migrations above in pgAdmin.

**Or with one command.** With `.env` pointing at an empty database, this runs `schema.sql` and every
migration in order, records what it applied in a `schema_migrations` table, and skips those next time:

```bash
npm run db:migrate
```

**Option C: a database on Render**

1. In the [Render dashboard](https://dashboard.render.com), choose **New → Postgres**. Pick a name,
   the region closest to your users (Frankfurt for South Africa), and a plan, then **Create Database**.
2. When it shows **Available**, open its **Connect** menu and copy the **External Database URL**.
3. Build the tables from your computer, passing that URL just for this command (Git Bash):

   ```bash
   DATABASE_URL="postgresql://...render.com/..." npm run db:migrate
   ```

   In PowerShell: `$env:DATABASE_URL="postgresql://..."; npm run db:migrate; Remove-Item Env:DATABASE_URL`.
   Run the same command again after pulling new migrations; it only applies what is new.
4. Optional demo data: `DATABASE_URL="..." npm run seed:demo`. Skip this for a real launch.
5. To run the API on Render too, see [Deploying the API to Render](#deploying-the-api-to-render).

Keep the URLs secret: they contain the database password. Never put them in a committed file.
Check Render's pricing page before relying on the free plan: free databases are removed after a time limit.

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

## Deploying the API to Render

[render.yaml](render.yaml) describes the web service. It connects to the existing Render database
(it does not create one).

1. Merge your work into `main` and push: Render deploys the `main` branch.
2. In the [Render dashboard](https://dashboard.render.com): **New → Blueprint**, connect the
   `Sportstures/Sportstures-backend` GitHub repository, and choose `main`.
3. Render asks for the values marked `sync: false`:
   - `DATABASE_URL`: the database's **Internal Database URL** (its **Connect** menu). The service
     and the database must be in the same region (`oregon` in `render.yaml`).
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`: the same
     Afrihost values as your `.env`. Without them no signup codes are sent.
4. **Apply**. Each deploy runs `npm ci --omit=dev`, then `npm run db:migrate && npm start`, so new
   migrations apply automatically. `JWT_SECRET` is generated by Render once and kept.
5. Check `https://<your-service>.onrender.com/health`, then point the web and mobile apps at
   `https://<your-service>.onrender.com/api`.

Notes:

- On the free plan the service sleeps after 15 minutes without traffic; the next request takes
  up to a minute to wake it. Choose a paid plan in `render.yaml` (or the dashboard) before launch.
- `TRUST_PROXY=1` is set so the login rate limits see each visitor's real address behind Render's proxy.
- To change a secret later, edit it under the service's **Environment** tab; never commit it.

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
| `DATABASE_URL` | *(unset locally)* | One connection string instead of the `DB_*` settings, e.g. Render's. When set, it wins |
| `DB_SSL` | *(automatic)* | `true`/`false` forces SSL on or off. Default: on for `*.render.com` hosts only |
| `TRUST_PROXY` | *(unset locally)* | Set to `1` behind a host's proxy (Render) so rate limits see real visitor addresses |
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
│   ├── config.js          # PostgreSQL connection pool (DATABASE_URL or DB_* settings)
│   ├── schema.sql         # Base tables (run first in pgAdmin)
│   ├── init.sql           # Same base tables, loaded automatically by Docker
│   └── migrations/        # Run in order after the base tables
├── postman/               # Postman collection for the auth flow
├── scripts/               # migrate.js (npm run db:migrate), seed-demo.js (npm run seed:demo)
├── src/
│   ├── server.js          # Express app and route mounting
│   ├── controllers/       # Request handlers (auth)
│   ├── middleware/        # authenticate, requireRole, validation
│   ├── routes/            # auth, contact, sports, teams, competitions, fixtures
│   └── utils/             # email, tokens, contacts, schools, sports, serializers
├── API.md                 # Endpoint reference for the website and app
├── .env.example           # Template for .env
├── render.yaml            # Render web service (see Deploying the API to Render)
└── docker-compose.yml     # PostgreSQL and pgAdmin
```

## Demo data

To fill your **development** database with demo schools, teams, coaches, fixtures and results (so the
website and mobile app have something to show):

```bash
npm run seed:demo            # adds the demo data (does nothing if it is already there)
npm run seed:demo -- --reset # removes the demo data, then adds it again
```

It creates 8 schools across 4 provinces, 32 teams (each with its own coach), a league per sport, and
about 70 fixtures: roughly 60% already played with scores, the rest coming up in the next three weeks.
Log in as `coach1@demo.sportstures.test` or `learner@demo.sportstures.test` with the password
`DemoPass1`. Everything it creates belongs to `@demo.sportstures.test` accounts, so `--reset`
removes only that and never touches real users or matches. It refuses to run when `NODE_ENV=production`.
It adds data to whichever database `DATABASE_URL` (or else `DB_NAME`) points at, so check that first.

## Useful commands

```bash
npm run db:migrate                             # build or update the database (schema + new migrations)
psql -U postgres -d sportstures -h localhost   # open the database in the terminal
docker compose logs -f postgres                # follow database logs (Docker)
```
