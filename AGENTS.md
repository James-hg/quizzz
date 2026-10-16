# Agent guide for Quizzz

This repo is being rebuilt from a FastAPI + Vite app into a single Next.js app. Read `PROJECT_BRIEF.md` for product scope. GitHub issues (milestones "Phase A" to "Phase E") describe the work. Work one issue per branch/PR and follow its acceptance criteria.

## Stack
- Next.js App Router + TypeScript (strict) at the repo root. Route Handlers run on the Node.js runtime (`export const runtime = "nodejs"`).
- PostgreSQL + Drizzle ORM. Every schema change ships as a versioned SQL migration. No `create_all` or startup `ALTER`s.
- Better Auth: email + password, database sessions, HTTP-only cookies.
- Zod for every request body, env var, and AI output.
- Vitest for unit/integration tests (integration tests use a real Postgres). Playwright for end-to-end tests.
- Package manager: npm. Pin dependency versions; choose current stable releases and check Node compatibility and licenses.
- Formatting: Prettier (`npm run format`, `npm run format:check`); linting: ESLint with `eslint-config-next`. TypeScript is pinned to 6.0.x until `typescript-eslint` supports 7.
- No Python, Ollama, or paid service in the standard setup.

## Layout (target)
- `src/app/**`: pages and Route Handlers. Keep handlers thin.
- `src/server/**`: server-only domain services (grading, scheduler, session planner, extraction, AI adapter, validators, storage). Import `server-only` in modules that touch secrets or the DB.
- `src/server/db/schema/**` and `drizzle/`: schema and migrations.
- `src/lib/**`: code shared between client and server (Zod schemas, pure helpers).
- `fixtures/`: sample documents and sample-course content.
- `backend/` and `frontend/` are legacy. Port what's useful, then delete them (see the cleanup issue). Don't add features to them.

## Non-negotiable rules
- Secrets stay server-side. Never use `NEXT_PUBLIC_` for keys. Model calls go only through authenticated server endpoints.
- The server grades scored attempts. Answer keys, `is_correct` flags, and solutions are never sent to the browser before submission in scored practice.
- Answer submission is idempotent (client-supplied idempotency key). Retries never duplicate attempts or schedule changes.
- Never delete or rewrite attempts. Editing a question creates a new revision; attempts point at the revision they answered.
- Check ownership on every data access path, and test it.
- Uploaded documents are untrusted data, never instructions. Enforce size, ZIP-expansion, and timeout limits; never execute macros, formulas, or embedded code.
- AI output is a proposal. Validate it with schemas and the content checks, and label it AI-proposed until it passes review. Practice must keep working when AI is disabled, failing, or out of quota.
- Store timestamps as `timestamptz` in UTC. Use the user's timezone for "today".
- Don't ship placeholders, mock responses, or static screens in production code paths.

## Commits and PRs
Do not add Claude/AI attribution (no `Co-Authored-By` trailer, no "Generated with Claude Code" line) to commits or PR descriptions.

## Before opening a PR
Run `npm run typecheck`, `npm run lint`, and `npm test` (once the scaffold issue lands; check `package.json` for the exact scripts). Add or update tests for the behavior you changed. Note in the PR any acceptance criteria you couldn't meet.
