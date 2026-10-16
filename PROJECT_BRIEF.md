# Quizzz: Product and Build Brief

## 1. Product concept

Quizzz turns a student's own course materials into a guided practice game that helps them understand concepts, remember them across days, and solve unfamiliar questions independently.

**Product promise:** Upload your course materials. Know what to practice next. See what you can do without help.

The starting point is an existing question bank, lecture notes, or slides. The lasting value is the practice loop: attempt, receive appropriate support, solve independently, and return after a delay.

AI prepares and explains content. The product manages the learning experience, records evidence of understanding, and chooses useful next activities.

The initial audience is university students studying for exams from their own materials. Start with one well-supported subject, preferably introductory probability/statistics or introductory programming, before claiming equal quality across disciplines. Definitions, conceptual questions, and procedural problems need different activities.

**Implementation constraints:** migrate to Next.js with TypeScript across the application. Make the default installation run without Python and without paid services. The primary delivery target is a published app using Gemini's free API tier through server-only endpoints. Ollama is an optional future extension, not a release dependency. Free public hosting has quotas and availability limits; do not promise unlimited free operation. Educational accuracy must be checked through source evidence, deterministic validation where possible, and evaluated review/uncertainty workflows; no model is guaranteed correct.

## 2. Product boundaries

The full product in this brief includes the five selected features from the research discussion, retaining their original numbers:

- Feature 1: reviews across days, using retrieval practice and successive relearning.
- Feature 2: mixed problem types, using interleaving and method selection.
- Feature 3: predictions before learning, using prequestions.
- Feature 4: complete missing solution steps, using faded worked examples.
- Feature 7: contextual AI help with graduated hints and independent follow-up.

Importing, editing, source references, scheduling, and progress reporting support those features. They are not separate product directions.

Initial exclusions: live multiplayer, public question marketplaces, class management, social feeds, leaderboards, lecture recording, and automatic LMS integrations. Spreadsheet export can remain a compatibility feature if present, but it is not the central experience.

## 3. Why students would use it

The student problems are concrete:

- "I have material, but I don't know what to study today."
- "I recognize the correct option, but cannot explain or reproduce the answer."
- "I can solve a worksheet when I know the chapter, but cannot choose the method on an exam."
- "I understand the solution when I read it, then get stuck doing it myself."
- "AI helped me finish, but I don't know whether I actually learned it."

Quizzz should demonstrate value in the first session: import a small set, answer a few questions, get help on one difficulty, and complete a new problem independently. Do not require extensive course setup before that experience.

## 4. Student experience

### First use

1. Create an account and a course, or use a supplied sample course to explore.
2. Upload a question bank, learning material, or both. Ask which kind of content it is.
3. Preview extracted content and correct uncertain questions or answers.
4. Confirm suggested topics and optionally enter an exam date.
5. Start a short session immediately.

If the file contains questions and answers, preserve them. If it contains notes, generate clearly labeled practice questions from the material. If answers are missing, mark them as unresolved or AI-proposed; do not silently treat generated answers as an original answer key.

### Returning use

The homepage offers one primary action: **Start today's session**. Show the course, estimated duration, and a short reason for the recommendation. Let students choose a time budget such as 5, 10, or 20 minutes.

Provide four understandable entry points:

- **Review:** revisit material across days.
- **Learn a topic:** predictions, a small source section, and guided practice.
- **Mixed practice:** choose between related methods and solve new instances.
- **Exam practice:** independent questions, optional timing, and feedback at the end.

These are entry points into shared activities, not four separate implementations. Guided steps and contextual help appear inside sessions. Exam practice disables hints for that session and does not masquerade as an official assessment.

### End of a session

Report independent answers, answers completed with help, topics needing practice, and the next planned review. Distinguish attempts from unique questions and original questions from generated variations.

Use statements such as "Recalled on three separate days" or "Solved two new examples without hints." Do not invent an exam-readiness percentage or promise a grade.

## 5. Feature specifications

### Feature 1: Reviews across days

**Student-facing purpose:** "Tell me what to review, and let me finish a manageable session."

Questions reappear after a delay. Incorrect items receive feedback and another opportunity later in the current session. A successfully recalled item can leave today's queue while remaining eligible for future reviews.

Track question-level memory separately from concept-level application. Remembering a definition is different from solving an unfamiliar problem about it.

Required behavior:

- Support MCQ, short-answer, and fill-in-the-blank retrieval where appropriate.
- Track unaided correctness, hints, solution reveals, and timestamps.
- Schedule delayed checks following independent success.
- Do not count success immediately after viewing a solution as delayed recall.
- Exclude unresolved or invalidated questions from grading and scheduling.
- Bound the session by the student's time budget and allow pause/resume.
- Spread overdue work into manageable sessions after missed days.
- Explain recommendations, for example "You needed a hint last time."

An initial transparent scheduling heuristic is acceptable: retry an unsuccessful item later in the session, revisit it on a later day, and lengthen intervals following successful delayed retrieval. Example intervals such as 1, 3, 7, and 14 days are initial product parameters, not scientifically optimal constants. Keep policy versioned and configurable. Respect the exam date and student's timezone without claiming every item can be mastered before the deadline.

Do not use response speed alone to infer knowledge. Optional confidence can provide context, but it must not override objective performance or become an extra required tap on every question.

**Acceptance:** help-assisted answers do not advance the independent-recall state; missed days do not create an endless mandatory queue; due dates persist correctly across devices and timezones.

### Feature 2: Mixed problem types

**Student-facing purpose:** "Recognize which method applies when the chapter title isn't supplied."

Interleave related, confusable types after students have some initial exposure. For probability, mix independence, conditional probability, and mutually exclusive events. Do not mistake unrestricted random shuffling for intentional interleaving.

Required behavior:

- Store concept tags, method tags, and relevant contrasts between concepts.
- Let students review and edit AI-suggested tags.
- Begin with focused instruction when the student lacks initial knowledge.
- Mix appropriate types and avoid excessive repetition of one method.
- Occasionally ask for a method choice before calculation.
- Explain the clue distinguishing the applicable method from alternatives.
- Track method-selection mistakes separately from calculation or execution mistakes.
- Include original and approved generated questions, with their origins preserved.

Do not reveal topic labels that give away the method in an exam-style mixed round. Explain the practice design in accessible terms and let the student switch to focused support when overwhelmed.

**Acceptance:** a mixed session contains deliberate concept contrasts; method choices are graded separately; insufficient question variety produces an honest limitation rather than fabricated content.

### Feature 3: Predictions before learning

**Student-facing purpose:** "Notice an important question before reading its explanation."

At the start of a new topic, show two or three short, ungraded prediction questions. Then present the relevant source section or a source-linked explanation, explicitly resolve the predictions, and provide a later check.

Example: "If two events cannot happen together, are they independent? Make your best prediction."

Required behavior:

- Clearly state that the topic may be unfamiliar and mistakes are expected.
- Permit a skip or an "I don't know yet" response.
- Record predictions separately from assessed practice; they do not lower progress.
- Select questions about central ideas that the following material actually addresses.
- Resolve every attempted prediction through correct information.
- Revisit the idea with a subsequent question, optionally in a new context.

This is not simply a placement test. Its instructional purpose is to direct attention before learning. Do not infer a persistent misconception from an uninformed prediction alone.

**Acceptance:** prediction responses never lower the student's performance record; the material that follows addresses each prompt; no wrong prediction remains uncorrected at the end of the activity.

### Feature 4: Complete missing solution steps

**Student-facing purpose:** "Give me enough support to take the next step, then help me work alone."

Use complete worked examples, partially completed examples, and independent problems. Choose the support level from observed performance and let students request more support or skip ahead.

For probability:

1. Show a complete example identifying the events, selecting the formula, substituting values, and calculating.
2. Supply the setup and ask the student to finish the calculation.
3. Ask the student to choose the setup and finish the result.
4. Present a new problem without support.

Required behavior:

- Represent solutions as structured steps with explanations and dependencies.
- Accept valid equivalent answers and alternate solution methods.
- Give feedback on the submitted step rather than only the final result.
- Gradually remove support when the student succeeds.
- Restore useful support after repeated difficulty.
- Offer the feature after a failed attempt or through "Walk me through a similar example."
- Use an independent follow-up to check learning.

Fading need not follow a rigid universal sequence. It depends on the task and student. Do not generate procedural steps for content that lacks a meaningful procedure.

A final answer from an imported MCQ is not proof of a valid worked solution. Require a checked source solution, deterministic validation where possible, or a review step before generated solutions enter scored practice. Label generated content explicitly.

**Acceptance:** students can complete and receive feedback on individual steps; assisted completion is separate from independent success; valid alternative methods are not rejected solely for differing wording or order.

### Feature 7: Contextual AI tutor

**Student-facing purpose:** "Help me with the exact part I'm stuck on."

The tutor receives the current question, relevant source passages, the student's attempt, the approved solution, and a limited summary of relevant prior difficulty. It does not require students to paste everything into a separate chat.

Offer clear actions:

- Give me a small hint.
- Explain this step.
- Why is my answer wrong?
- Show a similar example.
- Show the full explanation.

Use graduated help: conceptual clue, method or next-step hint, partially worked example, and full explanation. Students can choose stronger help without being trapped in a long scripted dialogue. Record the strongest assistance used before each answer.

Required behavior:

- Prefer short, specific responses tied to the current attempt.
- Preserve notation and definitions from the uploaded course source.
- Cite a usable source location when available.
- Distinguish source-supported claims from generated reasoning.
- State uncertainty and request review when evidence is missing or conflicting.
- Avoid giving away the answer in a nominally small hint.
- Offer a new independent check after substantial help.
- Keep help available without punishing the student for asking.
- Work with existing approved hints when an AI provider is unavailable.

Source references improve inspectability, but they are not automatic proof of correctness. A second model agreeing with the first is not sufficient verification.

**Acceptance:** assistance levels are recorded; a source reference resolves to the claimed passage; model failures leave the student's work intact; no AI credentials reach the browser.

## 6. Cohesive game design

Use a restrained solo challenge structure: a course contains topics, a session contains rounds, and an optional final challenge combines learned concepts. Make progress visible through evidence such as "first independent solution" and "remembered after a week."

Use calm completion feedback, clear goals, and optional challenge framing. Rewards must not affect the scheduler's evidence or encourage rapid guessing. A student can use untimed practice, disable decorative motion, request help, and end a completed session without penalty.

The game should remain useful without decorative elements. Readable questions and immediate, informative feedback take priority over animations.

## 7. Import and content pipeline

The long-term direction is broad document support. The first complete release should explicitly support DOCX, text-based PDF, PPTX, plain text/Markdown, CSV, and XLSX. Treat scanned documents and photographs as an OCR extension with separate quality indicators. Do not claim support for arbitrary files.

Pipeline:

1. Validate file type, size, ownership, and parsing limits.
2. Extract content while preserving source structure and available locations.
3. Show a preview and any extraction failures.
4. Identify existing questions, answer keys, and learning material.
5. Propose structured questions, concepts, and source links.
6. Flag missing answers, multiple plausible answers, duplicates, broken equations, or unresolved image dependencies.
7. Let the student accept, edit, or exclude content.
8. Publish approved items into the course's practice pool.

Keep extraction and generation separate. Preserve original wording and formatting where practical. Support an image attached to a question when extraction retains it. If a required diagram cannot be imported, mark the item incomplete.

For PDFs use page references; for slides use slide numbers; for DOCX use headings, paragraph anchors, or stored excerpt identifiers. Do not invent reliable Word page numbers when the parser cannot establish them.

If the document contains only questions without teaching material, Review and Mixed Practice can still work. Learn a Topic and worked-example activities need sufficient explanatory content or explicitly reviewed generated material.

### JavaScript-first extraction

Document parsing must not require a Python installation in the standard setup. Use a shared TypeScript extraction interface returning text blocks, formatting, assets, source anchors, and warnings. Keep extraction deterministic where possible; AI can interpret extracted content afterwards.

| Format | Initial implementation direction | Important limitation |
| --- | --- | --- |
| DOCX | Mammoth.js HTML conversion, with a targeted OOXML parser when necessary | Preserve explicit bold markers and list structure; raw text extraction loses answer-key formatting |
| Text PDF | Mozilla PDF.js (`pdfjs-dist`) for page-level text extraction and preview | Reading order, tables, equations, and columns need validation; images of text need OCR |
| PPTX | Extract OOXML with `fflate` and `fast-xml-parser`, following slide relationships | Preserve actual slide order and references; do not imply full visual-layout fidelity |
| TXT / Markdown | Read text directly and retain headings and positions | Sanitize rendered Markdown/HTML |
| CSV | A maintained JavaScript CSV parser with quoted-field support | Let users map question, choice, and answer columns |
| XLSX | ExcelJS with explicit column mapping | Handle answer representations consistently; legacy XLS is not automatically supported |

Mammoth maps explicit bold to HTML strong elements, which is relevant to the existing importer's bold-answer convention. Check fixtures for partial bold, inherited styles, lists, and wrapped options; do not assume every bold word makes the entire choice correct. Sanitize converted HTML before rendering. [Mammoth documentation](https://github.com/mwilliamson/mammoth.js).

Use ZIP entry/expanded-size limits, parser timeouts, file validation, and safe XML handling. Never execute macros, embedded code, external relationships, or formulas from uploaded documents. Preserve warnings instead of silently dropping unsupported elements.

Python is permitted only as an isolated, optional fallback after a documented JavaScript extraction gap is reproduced with representative fixtures. Explain the concrete quality benefit and keep that fallback outside the main Next.js runtime. Do not retain FastAPI or `python-docx`/`docx2txt` as mandatory services merely because they exist in the old project.

Implementation references: [PDF.js](https://github.com/mozilla/pdf.js), [ExcelJS](https://github.com/exceljs/exceljs), [fflate](https://github.com/101arrowz/fflate), [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser). Verify current Node.js compatibility, maintenance, and licenses before pinning versions.

## 8. Pages and interface

| Page | Main purpose |
| --- | --- |
| Home | Recommended session, time budget, recent courses |
| Course | Materials, topics, question bank, optional exam date |
| Import review | Extraction preview, warnings, answer corrections, approval |
| Question editor | Original text, choices, answers, tags, sources, hints, solution steps |
| Study session | Question/activity, progress, contextual help, pause/resume |
| Session results | Independent vs assisted performance, next review |
| Progress | Delayed recall, unseen-problem performance, untested topics |
| Settings | Account, timezone, accessibility, data export/deletion |

Keep the main question central and help beside it on desktop; use an accessible drawer on narrow screens. Render mathematics and code clearly. Provide keyboard navigation, visible focus, labeled controls, non-color-only correctness indicators, and reduced-motion support.

Show useful loading, empty, retry, and failure states. An import should provide progress and recoverable errors rather than leave the student waiting on an unexplained spinner.

## 9. Progress and session planning

Use evidence states such as:

- Not practiced.
- Learning with support.
- Solved independently.
- Recalled after a delay.
- Applied to a new problem.

These are transparent summaries, not permanent declarations of mastery. Show the underlying attempt count and dates where useful. One MCQ answer cannot establish conceptual understanding.

For a time-budgeted session, prioritize due reviews, recent difficulties, under-practiced selected topics, and appropriate independent checks. Avoid letting all due reviews crowd out every new learning opportunity. Keep selection rules explicit and configurable; an LLM should not independently decide all scheduling.

When estimating time, start conservatively and improve estimates using actual activity durations. Students can pause, skip, report a broken item, or end early without losing completed attempts.

## 10. Technical direction for the existing repository

### Target stack

Migrate the existing React/Vite and FastAPI application to a full-stack Next.js application. Retain reusable React components, TypeScript domain logic, existing PostgreSQL data, and working student behavior. Vite, React Router/custom path handling, FastAPI, SQLAlchemy, and Python document libraries are legacy components to replace in the standard runtime, not the target architecture.

| Layer | Target choice |
| --- | --- |
| Framework | Next.js App Router with React and TypeScript |
| Server | Next.js Route Handlers / server-only services using the Node.js runtime |
| UI | Reuse and improve current styles/components; accessible responsive layouts |
| Database | PostgreSQL, local by default; optional hosted free-tier PostgreSQL |
| Database access | Drizzle ORM and versioned SQL migrations |
| Authentication | Better Auth with database-backed sessions and secure HTTP-only cookies |
| Validation | Shared TypeScript schemas, for example Zod, with server-side validation |
| AI | Server-only Gemini free-tier adapter; optional future Ollama adapter |
| Extraction | JavaScript/TypeScript libraries described in Section 7 |
| File storage | Private local files by default; optional private hosted object storage |
| Jobs | Database-backed job records and a small Node.js worker |
| Local setup | Next.js, PostgreSQL, optional worker, and optional Gemini credentials; no mandatory Python or Ollama |

Choose supported stable versions at implementation time and pin compatible dependencies. Do not copy the old React/Vite versions into the new Next.js application without checking compatibility. Next.js supports backend endpoints through [Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers); Drizzle supports [PostgreSQL](https://orm.drizzle.team/docs/get-started/postgresql-new), and [Better Auth](https://better-auth.com/docs/introduction) provides an authentication library that can run within the app.

Use Server Components for server-rendered data where useful and Client Components for editing, answers, interactive sessions, and streaming help. Route Handlers should call reusable domain services for grading, scheduling, extraction, and AI. An additional Express or FastAPI server is not required.

### Migration and responsibilities

Existing accounts, folders, quiz editing, sessions, and answer history are reusable behavior and data foundations. Verify their actual contracts before migration. Preserve IDs, ownership, content, timestamps, and historical attempts where feasible. Create an explicit schema mapping and migration validation; do not use a destructive database reset.

Plan authentication migration explicitly. Existing password hashes and JWTs are not automatically compatible with a new library. Use supported legacy hash verification and rehash-on-login where appropriate, or a documented account recovery transition. Do not overwrite hashes or require plaintext passwords. Invalidate legacy sessions deliberately at cutover and explain the sign-in transition.

The inspected backend upload route currently supports only DOCX even though the frontend file picker lists more extensions. Resolve that mismatch through implemented support and accurate UI messaging.

The current AI provider calls the model from frontend code. Move model calls and credentials behind authenticated Next.js endpoints. Do not use `NEXT_PUBLIC_` variables for secrets. Use the Node.js runtime for document libraries and database operations that are incompatible with an edge runtime.

Suggested system responsibilities:

- Frontend: editing, session interaction, source display, accessibility.
- API: ownership, grading, scheduling, session state, AI orchestration.
- Database: durable content, attempts, revisions, review schedules, jobs.
- File storage: private source documents and extracted assets.
- Background worker: long imports and generation, with persisted job state.
- Validation layer: schemas, content checks, supported deterministic grading.

Adapt Docker Compose to the new stack while retaining PostgreSQL's existing data volume safely. The normal installation must not require local model downloads, a GPU, or a running Ollama service.

Start with bounded request-time imports for small files. Long imports use persisted jobs and the local Node.js worker. Do not rely on an unawaited task continuing after a serverless HTTP response. A hosted profile must use resumable, bounded work or an explicitly supported worker; do not silently require a paid queue service.

The server must grade scored attempts. Do not send correct-answer fields to the browser before submission in independent or exam practice. Make answer submission idempotent so retries cannot create duplicate attempts or duplicate schedule changes.

### AI choice: Gemini free tier for the published app

**Default provider: Gemini API on a free-tier project.** `gemini-2.5-flash-lite` was verified as a free input/output candidate during planning. It is a candidate, not a mandatory quality choice. Before implementation, verify current availability and quotas and compare currently free Gemini text models on the app's checked evaluation set. Select the best candidate that meets task-specific correctness requirements within free-tier limits; do not choose Lite solely for speed or quota. Do not carry forward the old hardcoded `gemini-2.0-flash` default. If no free model meets a feature's quality gate, use checked content or withhold that generated feature rather than publish unreliable output or enable paid fallback. [Official pricing](https://ai.google.dev/gemini-api/docs/pricing), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

Gemini's free-tier terms allow submitted content to be used to improve Google's products, subject to applicable terms. Explain hosted processing and provider data handling before the student's first AI upload/use; do not describe it as local processing or promise that documents never leave the app's infrastructure. Keep private application data and API credentials protected independently of the provider's terms.

Implement a small adapter supporting structured generation, hint/explanation streaming where supported, timeouts, cancellation, schema validation, and normalized quota/unavailable errors. Model output schemas need application-level validation even when a provider offers structured output. Cache reusable approved results and cap context/output size.

Configuration should include `AI_PROVIDER=gemini|disabled`, server-only `GEMINI_API_KEY`, and configurable `GEMINI_MODEL`. Default the published deployment to Gemini after credentials and free-tier status are configured. If credentials are absent, show a clear unavailable state and support approved question-bank practice without generation. Bound concurrency, output sizes, repair retries, and per-user/global usage. Keep normal practice available when free quotas are exhausted. Do not automatically upgrade billing or switch to a paid model.

Keep the adapter interface extensible for an optional future Ollama implementation. It must not delay or complicate the Gemini release. Any future self-hosted endpoint must be administrator-controlled and authenticated; deployed-server localhost is not a student's laptop. No local bridge, wake/sleep model server, or rented inference hardware is required for this release.

### Zero-paid-service operation

Treat zero paid services as a requirement, with two documented profiles:

1. **Published profile (primary):** Next.js on an eligible free host, free-tier PostgreSQL/private file storage, and Gemini's free API tier. Supabase is a candidate for PostgreSQL and private storage; keep Better Auth as the single auth system rather than layering a second auth service unnecessarily. Deployment remains conditional on current host terms, quotas, background-work support, and connection limits. Students need no local model installation or personal API key; the application uses its protected server-side project key.
2. **Local development profile:** Next.js + local PostgreSQL + private local files + Node.js worker, with optional Gemini free-tier credentials or disabled AI. This needs no paid API, hosted database, paid email provider, or GPU rental. Provide a working local sign-up/sign-in flow; do not require email delivery to use a local installation.

Vercel Hobby is intended for personal, non-commercial projects; it is a candidate for an eligible demo, not a promise of free commercial hosting. Hosted files cannot depend on ephemeral function disk. Use private storage and direct uploads where necessary to respect function request limits. Supabase free-tier resources are capped; check current limits and pausing behavior before deployment. [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Supabase pricing](https://supabase.com/pricing).

Do not enable paid billing, automatic upgrades, paid model fallback, paid OCR, paid vector databases, or always-on hosted workers. Start source retrieval with PostgreSQL text search and bounded source sections. Local embeddings are an optional later improvement, not a prerequisite.

Enforce file/page limits, per-user request limits, capped generation, cached explanations, bounded retries, and concurrency limits. On quota exhaustion, pause AI generation and preserve normal practice with already approved content. Do not treat budget alerts alone as a hard spending cap. A hosted free tier cannot guarantee unlimited users, continuous availability, or unlimited AI. Record verified quotas in deployment documentation and recheck them before launch.

## 11. Data model

Extend existing entities with migrations rather than discarding student data. Suggested conceptual entities:

| Entity | Important information |
| --- | --- |
| Course | Owner, title, subject, optional exam date |
| Source document | Owner/course, file metadata, extraction status, revision |
| Source segment | Text/assets, page/slide/anchor, stable identifier |
| Concept | Name, description, method tags, related/confusable concepts |
| Question revision | Prompt, type, options, answer/rubric, origin, approval status |
| Question-source link | Evidence segment and relationship to the question |
| Worked solution | Structured steps, acceptable answers, validation status |
| Generated variant | Parent question, concept, changed conditions, validation status |
| Study session | Mode, budget, state, current activity, policy version |
| Attempt | Question revision, response, correctness/uncertainty, assistance, timestamps |
| Help event | Hint level, content reference, provider metadata when needed |
| Review state | User/item, next due date, delayed successes, scheduling state |
| Concept evidence | Independent/assisted outcomes and new-problem checks |
| Content job | Type, progress, result, retry/error state |

Record prequestions separately or with an explicit activity role that excludes them from scored progress. Separate factual correctness from support level: a correct answer with a hint is still correct, but it is different evidence.

Version questions and solutions. Editing an answer key must not silently rewrite historical attempts. Invalidate or recompute affected summaries explicitly, and exclude reported broken items pending review.

## 12. AI, grading, and trust

- Uploaded material is untrusted content, not instructions to the application or model.
- Validate generated output against explicit schemas and semantic constraints.
- Require exactly the supported number of correct options for each question type.
- Use deterministic grading for MCQ and supported numeric/equivalent answers.
- Use rubrics for free responses, with an uncertain outcome and student correction path.
- Do not automatically record an uncertain model judgment as a definite failure.
- Permit students to report incorrect content and override a disputed practice assessment with a recorded reason.
- Distinguish content approval from mathematical or factual verification.
- Keep provider prompts, content generation, grading, and scheduling independently testable.
- Cache approved reusable hints and explanations; avoid a model call for every routine interaction.
- Rate-limit costly endpoints and track generation cost and latency.
- Preserve functional practice when AI is slow, unavailable, or returns invalid content.
- Keep each user's sources and generated content private by default and enforce ownership on every access path.
- Provide a documented path to export and delete account data, including source files and associated generated assets.

### Educational accuracy requirements

Gemini output is a proposal until the relevant checks pass. Syntactically valid JSON, low temperature, a confident answer, or a second model agreeing is not proof of educational correctness. Never promise 100% accuracy or label generated content "verified" solely because it was generated successfully.

Required content pipeline:

1. Retrieve relevant source segments from the student's materials, including the original question and answer key where provided. If supporting material is absent, do not invent a citation or silently substitute general knowledge for the instructor's content.
2. Generate structured output containing the answer, concise explanation or solution steps, concept tags, source segment IDs, and explicit unresolved issues. Ask for inspectable educational explanations, not hidden model reasoning.
3. Validate schema, source-ID ownership/existence, excerpt fidelity, supported question type, correct-option count, and whether the explanation agrees with the selected answer. These checks establish structure and consistency, not full factual support.
4. Validate numbers, units, calculations, or formal answers with deterministic checks when the supported subject permits. Do not execute unrestricted model-generated code. For approved numerical variants, prefer checked templates/solvers and validate every changed instance.
5. Compare generated answers with the supplied answer key. Preserve the original key and flag conflicts for review instead of silently changing it. A source key can itself be wrong, so agreement is evidence of fidelity rather than universal truth.
6. Attach honest evidence states: generated/unreviewed, source-linked, deterministically checked for named properties, human-reviewed, or needs review. Only include content in scored practice when the applicable question-type checks and approval requirements pass. Human acceptance alone is not independent expert verification.
7. Reject or quarantine ambiguous, contradictory, unsupported, or failed-validation content. Offer edit, source review, or exclusion. Do not force a correct answer when the source is incomplete.

For explanations and hints, display usable source references and distinguish any general explanation from what the course source explicitly supports. A reference resolving successfully does not establish that the passage entails the claim. Source support, answer correctness, and step validity must also be assessed in the evaluation set and review workflow. For an unresolved live request, respond with a concise limitation and point to the relevant source rather than fabricate certainty.

For grading, use the approved key or deterministic evaluator for MCQ and supported formal/numeric answers. Use a clear rubric for free responses and allow "cannot assess reliably." Uncertain AI grading must not lower a student's progress or update a review schedule as a definite failure. Preserve an appeal/edit path and assessment provenance.

For worked examples, validate every educationally important step and the final result where feasible; withhold scored procedural activities when validation is insufficient. For generated variants, re-check that the changes preserve a well-posed question and produce the stated answer and plausible wrong choices. Never reuse the parent's answer automatically after changing numbers or assumptions.

Version the model, prompt, source revision, validator, and generated artifact. Invalidate caches and reconsider approval when their dependencies change. Cache checked content to improve consistency and reduce free-tier usage, rather than generating a different explanation on every visit.

## 13. Research and adoption interpretation

No source below directly predicts usage of all five features inside Quizzz. Treat adoption rankings as hypotheses.

- **Feature 7: strongest existing demand for the underlying task.** In a 2025 YouGov survey, 81% of students who used AI for degree work used it to explain concepts. This does not establish preference for hint-first tutoring. https://yougov.com/en-gb/articles/52855-how-are-uk-students-really-using-ai
- **Features 1 and 2: useful methods with a behavior gap.** A 2025 survey of 1,093 undergraduates found low adoption of distributed and interleaved practice. Easy scheduling and embedded mixed practice are product responses to test. https://onlinelibrary.wiley.com/doi/10.1002/acp.70071
- **Feature 2: a preference hurdle.** Research on seventh-grade mathematics students found negative perceptions of interleaving; this population does not directly represent university students. https://uweb.cas.usf.edu/~drohrer/pdfs/Hartwig%26Rohrer2025.pdf
- **Feature 3: students may need help appreciating it.** Experimental research found that support such as comparative performance feedback improved awareness of pretesting benefits. It did not establish commercial app adoption. https://sc-pan.github.io/pdf/PR_2023.pdf
- **Feature 4: offer examples at moments of difficulty.** In probability-learning experiments, learners chose worked examples on fewer than 40% of trials and used them more after unsuccessful attempts. https://doi.org/10.1016/j.learninstruc.2017.10.002
- **Feature 7: measure independent learning.** A 2025 mathematics field experiment found that unrestricted AI assistance could improve assisted practice while harming later independent performance; a tutor with learning safeguards largely mitigated the harm. https://doi.org/10.1073/pnas.2422633122
- **Learning foundation:** spacing and retrieval have substantial support, with task-dependent implementation. https://doi.org/10.1038/s44159-022-00089-1
- **Prequestion scope:** benefits are strongest for the material actually questioned, rather than all nearby content. https://doi.org/10.3758/s13423-023-02353-8

## 14. Build sequence

The objective is the full product described here. Phases provide working checkpoints rather than permission to leave the rest as placeholders.

### Phase A: Reliable foundation

Audit the repository and migrate to Next.js App Router, TypeScript server services, Drizzle/PostgreSQL, and Better Auth. Preserve existing data through validated migrations and document authentication cutover. Replace mandatory Python extraction with the JavaScript DOCX pipeline. Move AI calls server-side and establish Gemini free-tier access with a disabled-AI mode. Add revision-aware questions, private sources, and an accurate DOCX import/review flow. Provide a checked sample course and local setup without paid services, Python, or Ollama.

Exit: a student can import, correct, save, play, and resume a quiz without relying on AI availability.

### Phase B: Contextual help and durable reviews

Implement Features 7 and 1 together: help levels, attempt records, independent checks, a deterministic review scheduler, today's session, and honest results. Implement the primary Gemini free-tier adapter, source-grounded output validation, content review/uncertainty states, quota handling, and checked-content fallback. Run the initial model comparison on independently checked educational examples before selecting the deployed model.

Exit: assistance affects learning evidence correctly, later reviews appear, and answer retries cannot corrupt history.

### Phase C: Broader material support and mixed practice

Implement the declared text/document/spreadsheet formats, persisted import jobs, source previews, concept tagging, and Feature 2. Preserve imported answer keys and review generated variants.

Exit: each supported format has an end-to-end tested import, and mixed practice selects meaningful contrasts.

### Phase D: Guided topic learning

Implement Feature 4 using checked structured solutions, then Feature 3 linked to course material. Reuse the same activity/session engine.

Exit: a student can predict, learn, complete faded steps, and attempt a new problem independently without prequestions contaminating scores.

### Phase E: Full-release quality

Finish progress views, independent exam practice, accessibility, mobile layouts, recovery states, data export/deletion, content evaluations, and setup documentation. Verify the primary published free-tier configuration, no-Python local installation, quota-exhausted and model-unavailable behavior, and educational accuracy gates. Scanned-image/OCR support can be a separately labeled subsequent extension and must not introduce a mandatory paid service.

Exit: all declared core flows work with real persisted data; no major feature is a decorative screen or mock response.

## 15. Verification and success measures

Automate meaningful checks for ownership boundaries, import integrity, server grading, idempotent submissions, scheduling/timezones, activity transitions, content revision handling, and AI failure recovery. Use representative source fixtures with consent or original sample content.

Manually inspect the complete student journey at desktop and mobile sizes, including mathematics/code rendering, keyboard access, empty states, and interrupted sessions. Check actual saved state after reload.

Maintain a small checked evaluation set for each supported subject and activity: valid answers, source accuracy, plausible distractors, hint leakage, solution-step correctness, and ambiguity. Do not advertise universal subject quality based on one successful demonstration.

Evaluate free-tier model candidates on the same held-out examples, with checked expected answers/rubrics that were not generated and approved solely by the model under test. Include missing sources, misleading answer keys, ambiguous questions, mathematical edge cases, prompt injection in uploads, source conflicts, and valid alternative answers. Measure answer correctness, claim-to-source support, step correctness, ambiguity handling, rubric agreement, latency, and quota consumption separately. Do not combine these into one reassuring but opaque quality score.

Before launch, define and document task-specific pass thresholds and the size/composition of the evaluation set. Hard release gates include no known unresolved critical wrong-answer defects in released checked content, no fabricated source references in the checked set, and passing tests that unsupported/uncertain outputs are withheld from scored practice. Passing a finite evaluation set does not prove universal accuracy. Disable a failing generated activity rather than ship it as reliable or quietly switch to a paid model. Re-run relevant evaluations after model, prompt, extraction, source-processing, or validator changes. If free quota blocks evaluation, leave the affected AI feature unvalidated and report that limitation; mocked responses do not substitute for real model-quality evaluation.

Product measures:

- Activation: import approved and first useful session completed.
- Repeated use: students return and finish sessions on separate days.
- Feature use: help requests, completed guided examples, mixed-session completion, and prediction skips.
- Independent outcomes: delayed recall and performance on genuinely unseen problems without hints.
- Efficiency: independent outcomes alongside total study time, including time reading help.
- Trust: reported broken questions, disputed grading, failed imports, and abandoned sessions.

Run a small pilot with target students before claiming learning gains. Separate feature popularity from learning effectiveness. An explanation button can receive many clicks without producing better independent performance. Set adoption targets only after establishing a baseline; do not invent evidence-based conversion percentages.

## 16. Handoff prompt for Claude Code

Read PROJECT_BRIEF.md in full, then inspect the existing repository and applicable repository instructions. Build the full Quizzz product described in this brief by extending the current application. Preserve existing user data and working functionality, and verify assumptions against the actual code.

First produce a short implementation plan mapped to the phases and identify any genuine blocking product questions. Resolve routine implementation choices yourself using the brief. Then implement complete vertical slices in phase order. Do not stop after planning, scaffolding, building static screens, or finishing only the first phase. Maintain a checklist of requirements and report concrete completed behavior and remaining gaps honestly.

The target stack is Next.js App Router with TypeScript for both UI and server logic, Drizzle/PostgreSQL, and Better Auth. Migrate the existing Vite/FastAPI implementation while preserving data and behavior. Use JavaScript/TypeScript document extraction by default; Python is an isolated optional fallback only for a demonstrated extraction gap. Keep model requests and credentials server-side. The primary target is a published app using Gemini's free API tier; select its configurable model using current free-tier availability and independently checked task evaluations. Ollama is optional future work, not a requirement. Keep a functional disabled-AI mode. Do not enable paid billing, paid fallback, or services requiring payment. Account for hosted quotas and provider data use. Implement the educational accuracy pipeline and release gates in Sections 12 and 15: source-grounded generation, deterministic checks where supported, explicit review/evidence states, uncertainty/abstention, safe grading, and quality regression evaluations. Withhold unreliable generated content rather than claim correctness. Use real persistence, versioned migrations, deterministic grading and scheduling where appropriate, and validated AI outputs. Preserve provenance, ambiguity, and assistance history.

Run checks appropriate to each meaningful change, verify the complete student experience, and fix failures within scope. Use local sample data and mocked provider responses for repeatable tests; any live model evaluation should be explicit about cost and limitations. Follow the repository's normal authorization requirements. Do not publish, deploy, send messages, or change shared external systems without authorization.

When complete, provide local setup/run instructions, environment variable documentation without secrets, migration instructions, verification results, and any material limitations. A feature is complete only when its end-to-end behavior and acceptance criteria work, not merely when its interface exists.
