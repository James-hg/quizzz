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

## Auth

Better Auth (email + password, database sessions, HTTP-only cookies) is mounted at `/api/auth/*`. No email verification is required locally. Passwords are never trimmed; only length (8-128) is validated.

```sh
# sign up (cookie saved to /tmp/quizzz-jar), read the session, update the profile
curl -c /tmp/quizzz-jar -H 'Origin: http://localhost:3000' -H 'Content-Type: application/json' \
  -d '{"email":"a@b.co","password":"correct horse","name":"A"}' localhost:3000/api/auth/sign-up/email
curl -b /tmp/quizzz-jar localhost:3000/api/me
curl -b /tmp/quizzz-jar -X PATCH -H 'Origin: http://localhost:3000' -H 'Content-Type: application/json' \
  -d '{"timezone":"America/Vancouver"}' localhost:3000/api/me
```

Other endpoints: `/api/auth/sign-in/email`, `/api/auth/sign-out`, `/api/auth/get-session`, `/api/auth/change-password` (requires the current password).

## Content API

All routes need a session cookie and return `404` for other users' ids. Errors look like `{ "error": { "code", "message" } }`.

| Route | Methods |
| --- | --- |
| `/api/courses` | `GET`, `POST` |
| `/api/courses/:courseId` | `GET`, `PATCH`, `DELETE` |
| `/api/courses/:courseId/question-sets` | `GET`, `POST` |
| `/api/question-sets/:setId` | `GET`, `PATCH` (rename), `DELETE` |
| `/api/question-sets/:setId/questions` | `GET`, `POST` |
| `/api/question-sets/:setId/questions/order` | `PUT` `{ questionIds }` |
| `/api/questions/:questionId` | `GET`, `PATCH` (creates a new revision), `DELETE` |
| `/api/questions/:questionId/revisions` | `GET` |
| `/api/questions/:questionId/exclude`, `/restore`, `/shuffle-options` | `POST` |

Editing never rewrites history: `PATCH` appends revision N+1, and attempts keep pointing at the revision they answered. Courses, sets and questions with attempts cannot be deleted (`409 has_history`); exclude a question instead. These owner endpoints include answer keys; the play endpoints (A9) will not.

```sh
curl -b /tmp/quizzz-jar -H 'Content-Type: application/json' -d '{"title":"CS 101","subject":"Intro","language":"python"}' localhost:3000/api/courses
curl -b /tmp/quizzz-jar -H 'Content-Type: application/json' -d '{"title":"Week 1"}' localhost:3000/api/courses/<courseId>/question-sets
curl -b /tmp/quizzz-jar -H 'Content-Type: application/json' -d '{"type":"mcq_single","prompt":"2+2?","options":[{"id":"a","text":"3"},{"id":"b","text":"4"}],"correctOptionIds":["b"],"approve":true}' localhost:3000/api/question-sets/<setId>/questions
curl -b /tmp/quizzz-jar -X PATCH -H 'Content-Type: application/json' -d '{"prompt":"What is 2+2?"}' localhost:3000/api/questions/<questionId>
curl -b /tmp/quizzz-jar localhost:3000/api/questions/<questionId>/revisions
```

## Uploads and extraction

Uploaded documents are untrusted data. `src/server/extract/` validates size and magic bytes (not just the extension), inspects ZIP containers without inflating them (entry count, declared and actual expanded size, path traversal), and runs extractors under a timeout. Extractors register with `registerExtractor`; the DOCX extractor arrives in A7. Original files are kept by `src/server/storage/` under `STORAGE_DIR` (default `./storage`) with random keys, outside the web root and never served over HTTP. `MAX_UPLOAD_BYTES` raises or lowers the size cap.

## DOCX import (extraction layer)

`registerDefaultExtractors()` (`src/server/extract/defaults.ts`) registers the DOCX extractor; `runExtraction()` validates the upload (size, magic bytes, ZIP limits) and runs it under a timeout. The import API that uses it arrives in A8.

- `src/server/extract/docx.ts` reads the OOXML directly (text, run-level bold including style-inherited bold, list levels, headings, images). It never fetches linked images, never runs macros, and rejects XML with a DTD or entities.
- `src/server/import/mcq-detect.ts` turns blocks into a draft of multiple-choice questions. A correct answer is proposed only when exactly one option is fully bold and none is partly bold. Otherwise the question gets `answerStatus` `ambiguous`, `unresolved`, or `multi_proposed` plus a warning, and the owner must decide.
- Fixtures live in `fixtures/docx/` and are generated by `npm run fixtures:docx` (original content, no copyrighted material).

```sh
npx vitest run src/server/extract src/server/import

## Import API

Upload a document, review the detected questions, then publish them into a question set. All routes need a session cookie and return `404` for other users' resources.

| Route | Purpose |
| --- | --- |
| `GET /api/import/formats` | Supported formats and the upload size limit |
| `POST /api/courses/:courseId/imports` | Multipart upload (`file` field) -> draft with items, warnings, source excerpts |
| `GET /api/imports/:importId` | Read a draft (also shows failed imports and their error) |
| `PATCH /api/imports/:importId/items/:itemId` | `{ decision: "accepted"\|"excluded"\|"pending", edit: {...} }` |
| `POST /api/imports/:importId/publish` | `{ title }` (new set) or `{ questionSetId }`; safe to retry |

Questions with no marked answer are never guessed. They publish with an `unresolved` answer key, `evidence_status=unresolved` and `status=excluded`, so they cannot be played or scheduled until the owner sets an answer (`PATCH /api/questions/:id` with `correctOptionIds`, then `POST /api/questions/:id/restore`). Unsupported types return `415` with `error.details.supportedFormats`.

```sh
curl -b /tmp/quizzz-jar localhost:3000/api/import/formats
curl -b /tmp/quizzz-jar -F file=@fixtures/docx/<fixture>.docx localhost:3000/api/courses/<courseId>/imports
curl -b /tmp/quizzz-jar localhost:3000/api/imports/<importId>
curl -b /tmp/quizzz-jar -X PATCH -H 'Content-Type: application/json' -d '{"decision":"accepted"}' localhost:3000/api/imports/<importId>/items/<itemId>
curl -b /tmp/quizzz-jar -X POST -H 'Content-Type: application/json' -d '{"title":"Week 1"}' localhost:3000/api/imports/<importId>/publish
```
