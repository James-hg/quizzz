# Quizzz

Quizzz helps students revise for exams. Import your own questions from a Word document (or write them), practise with server-graded sessions you can pause and resume, and optionally get AI help. Every question keeps its history: editing creates a new revision, and past attempts always point at the version you answered.

It is a single [Next.js](https://nextjs.org) app (App Router, TypeScript) with PostgreSQL, Drizzle ORM and Better Auth. There is no Python, no separate API server, and no paid service in the standard setup. AI is optional and off by default.

## Prerequisites

- **Node.js 22.12 or newer** (LTS) and npm
- **Docker** (easiest way to get PostgreSQL 16), or a local PostgreSQL 16+ you can create databases in

## Quick start

```sh
git clone <this repository> quizzz && cd quizzz
cp .env.example .env.local        # then set BETTER_AUTH_SECRET (see below)
docker compose up -d db           # PostgreSQL on localhost:5432 (creates quizzz and quizzz_test)
npm ci
npm run db:migrate                # applies the versioned SQL migrations in ./drizzle
npm run dev                       # http://localhost:3000
```

Generate the secret with `openssl rand -base64 32` and paste it after `BETTER_AUTH_SECRET=` in `.env.local`. Open <http://localhost:3000>, create an account, and you are in. Health check: <http://localhost:3000/api/health>.

**Port 5432 already in use?** Start the database on another port and match `DATABASE_URL`/`TEST_DATABASE_URL`:

```sh
DB_PORT=5433 docker compose up -d db
# .env.local: DATABASE_URL=postgres://quizzz:quizzz@localhost:5433/quizzz
```

**Upgrading from the old version?** It used a container named `quizzz-db` and a volume `quizzz_db_data`. The new setup does not reuse them (your old data is untouched). If that old container is running and holding port 5432, stop it with `docker stop quizzz-db` or use `DB_PORT` as above.

**No Docker?** Create the databases yourself (`createdb quizzz`, `createdb quizzz_test`) and point `DATABASE_URL` at them.

**Everything in containers:** `docker compose up` starts PostgreSQL, applies migrations, and runs the dev server on port 3000 (first start installs dependencies, so it takes a minute).

## Configuration

Copy `.env.example` to `.env.local`. Next.js, `npm run db:migrate`, `npm run samples:load` and `npm run test:integration` all read it; variables already set in your shell win. Nothing here is a secret by default, and **secrets are never exposed to the browser** (no `NEXT_PUBLIC_` variables are used).

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string for the app. |
| `BETTER_AUTH_SECRET` | yes | Signs sessions. At least 32 characters; keep it private. |
| `BETTER_AUTH_URL` | yes | Public URL of the app, for example `http://localhost:3000`. |
| `STORAGE_DIR` | yes | Private folder for uploaded documents (default `./storage`). Never web-served. |
| `AI_PROVIDER` | no | `disabled` (default) or `gemini`. |
| `GEMINI_API_KEY` | no | Server-only key for Gemini. Without it, `gemini` behaves as `disabled`. |
| `GEMINI_MODEL` | no | Model id. Defaults to a free-tier model, see [docs/ai-model.md](docs/ai-model.md). |
| `AI_REQUESTS_PER_HOUR` | no | Per-user cap on AI calls (default 30). |
| `MAX_UPLOAD_BYTES` | no | Upload size limit (default 10 MB). |
| `AUTH_RATE_LIMIT_MAX` | no | Sign-in/sign-up attempts per minute per client (default 10). |
| `DB_POOL_MAX` | no | Database pool size (default 5). |
| `SAMPLES_DIR` | no | Sample course folder (default `fixtures/sample-courses`). |
| `TEST_DATABASE_URL` | for tests | Dedicated database for integration tests; never `DATABASE_URL`. |

### AI: disabled vs Gemini

- **Disabled (default).** The AI panel says AI is off and everything else works, including import, editing and practice. AI routes answer `503 ai_unavailable`.
- **Gemini.** Set `AI_PROVIDER=gemini` and `GEMINI_API_KEY` (a free-tier key from Google AI Studio is enough). Calls are made by the server only, are rate limited per user, and their output is only ever a *proposal*: generated questions are saved excluded and unreviewed until you approve them. If the free quota runs out, AI routes return `429 ai_quota_exceeded` and practice keeps working; the app never switches to a paid model by itself.
- **Data use.** With the Gemini free tier, content you send (question text, the context of your question set) is processed by Google and, under Google's free-tier terms, may be used to improve their products. Do not enable AI for material you are not allowed to share. Disabled mode sends nothing anywhere.

## Using the app

| Page | What it does |
| --- | --- |
| `/sign-up`, `/sign-in` | Better Auth email + password. Sessions live in HTTP-only cookies. |
| `/` | Your courses, recent question sets, any practice session you can resume, and "Explore a sample course" (hidden when no samples exist). |
| `/courses/:id` | Course details, question sets (with counts), imported materials, import entry. |
| `/courses/:id/import` | Upload a document. The picker lists exactly the formats the server supports. |
| `/imports/:id` | Review detected questions: fix flagged items, accept or exclude, then publish. Unresolved answers are marked; those questions are added excluded until you set an answer. |
| `/question-sets/:id/edit` | Question editor (every save creates a new revision), AI panel, past sessions. Filter with `?filter=needs-review`, `no-answer` or `excluded`. The assistant box understands edit commands ("rename this set to ...", "add a question", "update question 2", "remove question 3", "shuffle the questions", "shuffle the choices", "create a set called ...") with or without AI; each shows a preview and waits for you to confirm. |
| `/question-sets/:id/play/:sessionId` | Practice. Reloading resumes where you were. |
| `/settings` | Display name, email, timezone, password. |

With `AI_PROVIDER=disabled` the AI panel says so and everything else works. The play screen never receives answer keys before you submit an answer.

Component and state tests: `npx vitest run src/components`. The main flow (sign up, import, fix, publish, practise, finish) is also covered at handler level in `src/app/journey.integration.test.ts`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Run, build, and serve the app |
| `npm run db:migrate` | Apply SQL migrations (idempotent; the app never changes the schema at startup) |
| `npm run db:generate` | Create a migration after editing `src/server/db/schema` |
| `npm run db:studio` | Browse the database |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | Static checks |
| `npm run test:unit` | Unit and component tests, no database needed |
| `npm run test:integration` | Integration tests against `TEST_DATABASE_URL` (each test is rolled back) |
| `npm test` | Both |
| `npm run samples:validate` | Validate sample course fixtures (also runs in CI) |
| `npm run samples:load -- <language> --email <email>` | Copy a sample course into an account |
| `npm run check:bundle` | After `npm run build`, fail if a secret appears in browser-visible output: `.next/static` and the prerendered pages (`.html`, `.rsc`, `.body`, `.meta`) under `.next/server/app`. Also fails if there is nothing to scan |

## Sample courses

Ready-made courses (one per language) a student can copy into their account. The content is written and checked by the project owner; see [fixtures/sample-courses/README.md](fixtures/sample-courses/README.md) for the format and how to add one. With none present, the app shows none.

## Project layout

- `src/app/**` pages and Route Handlers (kept thin)
- `src/server/**` server-only services: grading, sessions, import, extraction, AI adapter, storage
- `src/lib/**` code shared by browser and server (Zod schemas, pure helpers)
- `src/server/db/schema` and `drizzle/` schema and SQL migrations
- `fixtures/` sample documents and sample courses, `docs/` reference docs
- [docs/api.md](docs/api.md) the HTTP API with curl examples; [AGENTS.md](AGENTS.md) engineering rules; [PROJECT_BRIEF.md](PROJECT_BRIEF.md) product scope

Before opening a pull request run `npm run typecheck && npm run lint && npm test`.
