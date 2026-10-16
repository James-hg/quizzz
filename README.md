# Quizzz

A quiz app to revise for exams. The app is being rebuilt as a single Next.js app (see `PROJECT_BRIEF.md`); `backend/` and `frontend/` are legacy and will be removed.

## Local setup (no Python)

```sh
cp .env.example .env.local   # set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db      # PostgreSQL 16 on localhost:5432
npm ci
npm run db:migrate           # applies versioned SQL migrations in ./drizzle
npm run dev                  # http://localhost:3000, health: /api/health
```

Or run everything in containers: `docker compose up` (starts Postgres, runs migrations, then the dev server).

The database user/password/name in compose are `quizzz`/`quizzz`/`quizzz`, matching `.env.example`.

## Database

- Drizzle ORM with the `postgres` (postgres.js) driver. Schema lives in `src/server/db/schema`.
- Change the schema, then `npm run db:generate` to create a SQL migration in `drizzle/`, and `npm run db:migrate` to apply it. The app never alters the schema at startup.

## Tests

```sh
npm run test:unit          # no database needed
createdb quizzz_test       # or create it in your Postgres container
TEST_DATABASE_URL=postgres://quizzz:quizzz@localhost:5432/quizzz_test npm run test:integration
```

`npm test` runs both. Integration tests use a dedicated database (`TEST_DATABASE_URL`, never `DATABASE_URL`), and each test runs in a transaction that is rolled back.
