# Learning schema (Phase B)

The tables that record how much help a student used, when to review a question again, and how
well they know a concept. This page says what each one is for and which ticket fills it.
Only the schema exists so far; the services come later.

## Help and assistance

A correct answer with a hint is still correct, but it is different evidence from an unaided
one. Two places record that.

- **`attempts.assistance_level`**: the strongest help used before an answer, in this order:
  `none`, `conceptual_hint`, `next_step_hint`, `partial_example`, `full_explanation`,
  `solution_revealed`. It is set when the attempt is stored and cannot change (attempts are
  never updated). Existing attempts read `none`. The enum's declaration order is the strength
  order, so `max(assistance_level)` is the strongest.
- **`help_events`**: one row per help request, written **before** the answer exists. Because of
  that it belongs to a *turn*, `(session_id, question_id, pass)`, not to an attempt. `pass` is 1
  for the first try and 2 for the retry (requeue mode), so a question can have help recorded for
  both tries. A turn corresponds to exactly one attempt (unique on session, question, pass), and
  when the answer is submitted `attempt_id` is filled in once. A database trigger keeps every
  other column fixed and refuses a link to an attempt of another user, session, question, or
  turn. Generated text is stored as shown (`content_text`); a reusable hint is referenced by
  `approved_hint_id`. At least one is required. To list the help behind an attempt, join
  `help_events.attempt_id`.
  `source_segment_ids` is a `uuid[]`: Postgres cannot enforce foreign keys on arrays, so ids may
  dangle if a document is deleted; readers should ignore ids that no longer resolve.
- **`approved_hints`**: reusable hint text per question revision and level, for when the AI is
  off or failing. Unique per `(revision, level)`; level is a real hint level (not `none`, not
  `solution_revealed`). They are content, so they are deleted with their revision. A question
  that has help events counts as having study history and is excluded rather than deleted.

## Review scheduling

- **`scheduler_policies`**: versioned parameters, validated by `schedulerPolicyConfigSchema`
  (`src/lib/schemas/scheduler.ts`). Version `v1` is seeded by migration `0010`: one in-session
  retry, reviews after 1, 3, 7 and 14 days, a correct answer that used help does not advance the
  schedule, and a lapse steps back one interval. These are product parameters, not scientific
  claims. Never edit a version that review states use; add a new version
  (`addSchedulerPolicy`). `study_sessions.policy_version` and `review_states.policy_version`
  reference it.
- **`review_states`**: one row per `(user, question)`: `state` (`new`, `learning`, `reviewing`,
  `suspended`), `step_index`, `next_due_at` (timestamptz), `last_independent_success_at`,
  `delayed_success_count`, `distinct_success_days`, `lapses`, and the policy version. Filled by
  the scheduler (B2) and planner (B3).

## Concepts

- **`concepts`**: a deliberately minimal table (course, owner, unique name) so evidence has
  something to point at. C8 (#36) adds descriptions, method tags, and confusable links.
- **`concept_evidence`**: per `(user, concept)`: `independent_correct`, `assisted_correct`,
  `new_problem_checks`, `last_at`. Independent and assisted outcomes are kept apart on purpose.

## Who fills these

| Table | Written by |
| --- | --- |
| `attempts.assistance_level`, `help_events`, `approved_hints` | Tutor service (B5) and hint cache |
| `review_states`, `scheduler_policies` | Review scheduler (B2), session planner (B3) |
| `concepts`, `concept_evidence` | Concept tagging (C8) and the progress page (E1) |
