# API reference

All routes are Next.js Route Handlers on the Node.js runtime. Everything except sign-up, sign-in and `GET /api/health` needs a session cookie, and another user's resource always returns `404`. Errors look like `{ "error": { "code", "message", "details?" } }`.

The curl examples assume a cookie file from signing up (see **Auth**) and the dev server on `localhost:3000`.

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

**Review state.** A question you write or edit yourself (origin `original`) with an answer is `human_reviewed` straight away, so it can be practised; `approve` is ignored for it. `evidence_status = unresolved` now means only that the answer is missing (`answerKey.kind = "unresolved"`), and such a question is never practised or graded (restoring it returns `409 unresolved_answer`). Questions that did not come from you (AI-proposed, AI-variant, sample) stay `generated_unreviewed` / `needs_review` / `rejected` when edited without `{"approve": true}`, and become `human_reviewed` once you approve them. A checked sample question edited without approval goes back to `needs_review`. `POST /api/questions/:id/restore` returns `409 needs_review` for any of those states until they are approved. Migration `0006` relabelled existing owner questions that had been saved as `unresolved` despite having an answer.

**Question images.** A question can show one picture (PNG, JPEG or WebP; SVG, GIF and anything else is refused with `415 unsupported_image`; larger than `MAX_IMAGE_BYTES`, 2 MB by default, is `413 image_too_large`). The type is read from the file's bytes, not its name.

```sh
# 1. upload (stages the image; nothing shows it yet)
curl -b jar -F file=@cat.png localhost:3000/api/question-sets/<setId>/images      # -> { "image": { "id", "url", ... } }
# 2. attach it, with a description (required), when creating or editing a question
curl -b jar -H 'Content-Type: application/json' -d '{"type":"mcq_single","prompt":"What is shown?","options":[{"id":"a","text":"A cat"},{"id":"b","text":"A dog"}],"correctOptionIds":["a"],"image":{"imageId":"<id>","alt":"A cat on a sofa"}}' localhost:3000/api/question-sets/<setId>/questions
```

`PATCH /api/questions/:id` keeps the image when `image` is left out, replaces it (or just its description) with `{ "imageId", "alt" }`, and removes it with `"image": null`. Every edit, shuffle or review change carries the image forward, and older revisions keep showing what they showed. Owner views and the play view include `image: { id, url, alt } | null`. `GET /api/images/:imageId` is the only way to read an image: it needs a session that owns it (others get `404`, the same as a missing image), and responds with `nosniff`, a sandboxing CSP and `Cache-Control: private, no-cache`. `DELETE /api/images/:imageId` discards one of your own images that nothing uses (`409 image_in_use` otherwise); the editor calls it when a question fails to save after its picture was uploaded. A user can hold up to 50 uploaded-but-unattached images; at the limit, uploads you abandoned more than an hour ago are released automatically, and only if they are all recent is the upload refused (`409 too_many_staged_images`). A picture an import draft is waiting to publish is not counted and is never purged. Deleting a never-attempted question or set deletes the images only it showed; `purgeOrphanImages` (not scheduled yet) removes old unattached ones.

**Images in DOCX imports.** A picture next to a question (PNG, JPEG or WebP, within the size limit) is stored with the draft item as `payload.image`, with the description from Word if the author wrote one (cut to 300 characters if longer). A picture used by several questions is stored once and each question gets its own reference. The "image not imported" warning stays only for pictures that could not be kept (other formats, too large, linked) and for extra pictures beyond the first. An item whose image has no description cannot be accepted (`400 image_alt_required`); describe it with `PATCH .../items/:itemId` `{ "edit": { "image": { "imageId", "alt" } } }`, or drop it with `{ "edit": { "image": null } }` (a dropped image is deleted when nothing else needs it). Publishing links the image to the new question.

Editing never rewrites history: `PATCH` appends revision N+1, and attempts keep pointing at the revision they answered. Courses, sets and questions with attempts cannot be deleted (`409 has_history`); exclude a question instead. These owner endpoints include answer keys; the play endpoints (A9) will not.

```sh
curl -b /tmp/quizzz-jar -H 'Content-Type: application/json' -d '{"title":"CS 101","subject":"Intro","language":"python"}' localhost:3000/api/courses
curl -b /tmp/quizzz-jar -H 'Content-Type: application/json' -d '{"title":"Week 1"}' localhost:3000/api/courses/<courseId>/question-sets
curl -b /tmp/quizzz-jar -H 'Content-Type: application/json' -d '{"type":"mcq_single","prompt":"2+2?","options":[{"id":"a","text":"3"},{"id":"b","text":"4"}],"correctOptionIds":["b"]}' localhost:3000/api/question-sets/<setId>/questions
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

**Question numbers.** Numbers typed into a prompt (`1.`, `1)`, `(1)`, `Question 3:`, `Q3.`) are removed at import, and the wording as written is kept in the item's `payload.originalPrompt` so it can be put back. Only clear numbering is touched: `2 + 2 = ?`, `5 - 3 = ?`, `3 apples cost 6. ...`, `1.2 mg ...` and four-digit years are left alone, and Word's automatic numbering is not part of the text at all. The review page's "Remove question number" toggle uses `PATCH .../items/:itemId` with `{ "edit": { "prompt": "...", "originalPrompt": "..." | null } }` and the item's current `decision`, so toggling never accepts or excludes an item. Editing the prompt yourself should send `originalPrompt: null`. Publishing stores `payload.prompt` exactly as shown and ignores `originalPrompt`.

Questions with no marked answer are never guessed. They publish with an `unresolved` answer key, `evidence_status=unresolved` and `status=excluded`, so they cannot be played or scheduled until the owner sets an answer (`PATCH /api/questions/:id` with `correctOptionIds`, then `POST /api/questions/:id/restore`). Unsupported types return `415` with `error.details.supportedFormats`.

```sh
curl -b /tmp/quizzz-jar localhost:3000/api/import/formats
curl -b /tmp/quizzz-jar -F file=@fixtures/docx/<fixture>.docx localhost:3000/api/courses/<courseId>/imports
curl -b /tmp/quizzz-jar localhost:3000/api/imports/<importId>
curl -b /tmp/quizzz-jar -X PATCH -H 'Content-Type: application/json' -d '{"decision":"accepted"}' localhost:3000/api/imports/<importId>/items/<itemId>
curl -b /tmp/quizzz-jar -X POST -H 'Content-Type: application/json' -d '{"title":"Week 1"}' localhost:3000/api/imports/<importId>/publish
```

## Play API (quiz sessions)

The server grades; answer keys, explanations and correctness never reach the browser before submission.

| Route | Purpose |
| --- | --- |
| `POST /api/sessions` `{ questionSetId, mode: "quiz" }` | Resume the live session for the set (200) or create one (201). Excluded questions and questions that need review (sample, AI-proposed) are skipped. When nothing can be practised: `409 no_playable_questions` with `error.details` `{ total, playable, needsReview, noAnswer, excluded }`, so a client can say why. |
| `GET /api/sessions/:id` | State, elapsed time, progress, the current question (no key or explanation), and results for answered items. |
| `POST /api/sessions/:id/answers` `{ questionId, response, idempotencyKey }` | Grade and store one answer. The same key returns the stored result (`replayed: true`) with no second attempt. 409 when the session is completed or paused. |
| `PATCH /api/sessions/:id` `{ action: "pause" \| "resume" }` | Elapsed time only counts while active. |
| `POST /api/sessions/:id/complete` | End the session (also with unanswered items); returns a summary. |
| `GET /api/question-sets/:id/history` | Completed sessions with `answered` / `correct` / `totalItems`, from one aggregate query. |

A session pins the revision of every question when it starts, so editing a question mid-session does not change what that session shows or how it grades; the edit applies to the next session. Questions removed from the set mid-session appear as `removed` and are skipped.

```sh
# after signing up (see Auth) and creating a course, set, and question (see Content API):
curl -b jar -H 'Content-Type: application/json' -d '{"questionSetId":"<setId>"}' localhost:3000/api/sessions
curl -b jar localhost:3000/api/sessions/<sessionId>
curl -b jar -H 'Content-Type: application/json' \
  -d '{"questionId":"<questionId>","response":{"kind":"options","selectedOptionIds":["b"]},"idempotencyKey":"try-0001"}' \
  localhost:3000/api/sessions/<sessionId>/answers      # run it twice: second reply has "replayed": true
curl -b jar -X PATCH -H 'Content-Type: application/json' -d '{"action":"pause"}' localhost:3000/api/sessions/<sessionId>
curl -b jar -X POST localhost:3000/api/sessions/<sessionId>/complete
curl -b jar localhost:3000/api/question-sets/<setId>/history
```

Response shapes: `{"kind":"options","selectedOptionIds":[...]}`, `{"kind":"text","text":"..."}`, `{"kind":"blanks","values":[...]}`.

## AI (optional)

AI is off by default (`AI_PROVIDER=disabled`); practice never needs it. To enable Gemini, set `AI_PROVIDER=gemini` and a server-only `GEMINI_API_KEY` (optionally `GEMINI_MODEL`, see `docs/ai-model.md`). Keys never reach the browser: `npm run build && npm run check:bundle` fails if a secret appears in client output.

| Route | Purpose |
| --- | --- |
| `POST /api/ai/chat` | `{ message, history?, courseId?, questionSetId? }` -> short reply |
| `POST /api/ai/question-sets/:id/generate-questions` | `{ count?, topic? }` -> validated proposals, nothing saved |
| `POST /api/ai/question-sets/:id/save-proposals` | `{ proposals }` -> stored as excluded, `ai_proposed`, `generated_unreviewed` |
| `POST /api/ai/question-sets/:id/suggest-title` | -> `{ title }` |

AI routes return `503 ai_unavailable` when AI is off. Saved proposals stay out of practice until you approve them (`PATCH /api/questions/:id` with `{"approve": true}`) and restore them (`POST /api/questions/:id/restore`); restore returns `409 needs_review` until then.

```sh
curl -b /tmp/quizzz-jar -X POST -H 'Origin: http://localhost:3000' -H 'Content-Type: application/json' \
  -d '{"message":"What is a list comprehension?"}' localhost:3000/api/ai/chat
curl -b /tmp/quizzz-jar -X POST -H 'Origin: http://localhost:3000' -H 'Content-Type: application/json' \
  -d '{"count":3,"topic":"loops"}' localhost:3000/api/ai/question-sets/<setId>/generate-questions
```

## Sample courses

Ready-made courses (one per language) that a student can copy into their account. The project owner supplies the checked content; see `fixtures/sample-courses/README.md` for the format, the template, and how to add one. With none present, the app shows none.

| Route | Purpose |
| --- | --- |
| `GET /api/samples` | Available samples (`language`, `title`, counts); empty when there are none |
| `POST /api/samples/:language/load` | Copy a sample into your account: `201` the first time, `200` with the same copy afterwards |

```sh
npm run samples:validate                                   # also runs in CI
npm run samples:load -- python --email you@example.com     # copy into an account from the CLI
curl -b /tmp/quizzz-jar localhost:3000/api/samples
curl -b /tmp/quizzz-jar -X POST -H 'Origin: http://localhost:3000' localhost:3000/api/samples/python/load
```
