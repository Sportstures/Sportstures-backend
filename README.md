# Sportstures Backend Setup

## Project Overview
Backend API for managing sports teams, coaches, users, fixtures, and scores.

### Tech Stack
- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: PostgreSQL
- **Admin Panel**: pgAdmin
- **Package Manager**: npm

## Prerequisites
- Node.js (v16+)
- pgAdmin4 (installed locally)
- PostgreSQL (local or remote connection)
- npm

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Set Up Environment Variables
Copy `.env.example` to `.env` if not already done:
```bash
cp .env.example .env
```
Update `.env` with your database credentials:
```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=Prince@082
DB_NAME=sportstures
PORT=5000
NODE_ENV=development
```

### 3. Create Database in pgAdmin
Since you have pgAdmin4 installed locally:

1. **Open pgAdmin**: http://localhost:5050 (or your pgAdmin address)
2. **Create Database**:
   - Right-click on "Databases" → Create → Database
   - Name: `sportstures`
   - Click "Save"

3. **Run SQL Schema**:
   - In pgAdmin, go to Tools → Query Tool (or right-click database → Query Tool)
   - Open and run the script from `db/schema.sql`:
   ```sql
   -- Copy and paste contents of db/schema.sql here
   ```
   - Execute the query to create all tables and indexes
   - For an existing database, also run `db/migrations/001_auth_foundation.sql`
     followed by `db/migrations/002_player_signup_verification.sql` and
     `db/migrations/003_free_text_player_sport.sql`

Player email verification requires an SMTP server. Set `SMTP_HOST`, `SMTP_PORT`,
`SMTP_FROM`, and the SMTP credentials (when required) in `.env` using the
placeholders in `.env.example`.

### 4. Start the Backend Server
```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm start
```

The server will run on `http://localhost:5000`

### 5. Verify Setup
Check server health:
```bash
curl http://localhost:5000/health
```

Expected response:
```json
{
  "message": "Server is running",
  "timestamp": "2026-10-14T..."
}
```

## Project Structure
```
Backend/
├── db/
│   ├── config.js        # PostgreSQL connection pool
│   └── init.sql         # Initial database schema
├── src/
│   └── index.js         # Express server entry point
├── .env.example         # Environment variables template
├── .gitignore           # Git ignore rules
├── docker-compose.yml   # Docker services configuration
├── package.json         # Node.js dependencies
└── README.md            # This file
```

## Database Schema

### Tables
- **users**: User accounts (email, password, name, phone)
- **coaches**: Coach profiles linked to users
- **teams**: Sports teams with coach assignment
- **fixtures**: Match schedules (home team, away team, date)
- **scores**: Match results (fixture scores)

## Next Steps
1. ✅ Set up PostgreSQL and pgAdmin
2. 📝 Create API routes (users, coaches, teams, fixtures, scores)
3. 🔐 Add authentication & authorization
4. 📚 Add input validation & error handling
5. 🧪 Add unit & integration tests

## Useful Commands

### Run SQL Script in pgAdmin
1. Open pgAdmin → Select `sportstures` database
2. Go to **Tools → Query Tool**
3. Open `db/schema.sql` file or copy-paste its contents
4. Execute the query

### Access PostgreSQL CLI (if installed)
```bash
psql -U postgres -d sportstures -h localhost
```

### View Logs in pgAdmin
- Right-click Server → View Log

## Environment Variables Reference
| Variable | Your Value | Purpose |
|----------|------------|---------|
| `DB_HOST` | localhost | PostgreSQL host |
| `DB_PORT` | 5432 | PostgreSQL port |
| `DB_USER` | postgres | Database user |
| `DB_PASSWORD` | Prince@082 | Database password |
| `DB_NAME` | sportstures | Database name |
| `PORT` | 5000 | Express server port |
| `NODE_ENV` | development | Environment mode |

## Notes
- The database schema is in `db/schema.sql` — run it in pgAdmin Query Tool
- Use pgAdmin to manage the database visually or access via CLI if PostgreSQL is installed locally
- All environment-sensitive values are in `.env` (not committed to git)
#