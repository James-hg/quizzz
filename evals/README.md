# Evaluation sets

Checked examples used to compare Gemini models and to decide which AI features are good enough
to ship. **This folder is empty on purpose.** Cases here must be checked by a person, so no model
can be chosen or praised until the owner adds some. The harness itself is tested with synthetic
smoke fixtures in `src/test/fixtures/eval-smoke/`, which are never quality evidence.

## Layout

```
evals/<language>/<task>.jsonl      one case per line
```

`<language>` is a short folder name such as `python`, `java`, `cpp`. `<task>` is one of
`hint`, `explanation`, `question_generation`, `short_answer_grading`. Every line must say its own
`task` and `language`, and they must match the file.

## Adding a case

Each line is one JSON object. Common fields:

| Field | Meaning |
| --- | --- |
| `id` | Unique across all files. Lowercase letters, digits, `.` `_` `-`. |
| `task`, `language` | Must match the file path. |
| `allowedCitationIds` | Passage ids (from `input.passages`) the help may cite. Empty when no passage genuinely supports the answer. |
| `tags` | Any of `missing_source`, `misleading_key`, `ambiguous`, `prompt_injection`, `alternative_valid_answer`, `subject_edge_case`, `retry_protected`. |
| `review` | `{ "checkedBy", "checkedAt": "YYYY-MM-DD", "rationale" }`. Who checked the expected answer, when, and why it is right. Required. |
| `sourceVersion` | Where the content came from and its version. |
| `input`, `expected` | Depend on the task, below. |

**Do not use content only a model has checked.** A model must never be the only reviewer of a case
it is scored on. Use material you are allowed to send to Gemini's hosted API (synthetic, public
or your own notes). The AI-drafted sample courses are not checked and must not be copied here
without review.

### `hint` and `explanation`

```json
{"id":"py-list-len-hint","task":"hint","language":"python","allowedCitationIds":["s1"],"tags":[],
 "review":{"checkedBy":"Your name","checkedAt":"2026-11-01","rationale":"len counts items; checked against the docs."},
 "sourceVersion":"python-notes-v1",
 "input":{"question":{"type":"mcq_single","prompt":"What does len([1, 2, 3]) return?","options":[{"id":"a","text":"2"},{"id":"b","text":"3"}],"answerKey":{"kind":"options","correctOptionIds":["b"]}},
          "action":"small_hint",
          "passages":[{"id":"s1","filename":"lists.md","location":"paragraph 2","text":"len returns the number of items."}]},
 "expected":{"forbiddenAnswerStrings":["3"],"requiredCitationIds":["s1"],"rubric":["Points at counting items without saying the number."]}}
```

- `action`: hints use `small_hint` or `why_wrong`; explanations use `explain_step`,
  `similar_example` or `full_explanation`. `why_wrong` also takes `priorWrong` (a response).
- `protectedRetry: true` means a retry is pending, so even an explanation must not state the answer.
- `expected.forbiddenAnswerStrings`: text the help must not contain (the answer, or an injected
  instruction). Required for `small_hint`.
- `expected.acceptedAnswerStrings`: any one appearing counts as reaching the right answer.
  Required for an explanation unless the case is tagged `ambiguous`.
- `expected.abstain`: the honest reply is to say it is unsure or that no passage supports it.
- `expected.rubric`: what a person checks that a script cannot (steps, reasoning).
- A `missing_source` case must have no `allowedCitationIds`.

### `question_generation`

`input`: `course { title, subject, language }`, `existingPrompts`, `count` (1 to 5), optional
`topic`. `expected`: `forbiddenStrings` (must not appear in any generated question) and `rubric`.

### `short_answer_grading`

`input`: a short-answer, fill-in or output `question` and a `response`. `expected`:
`outcome` (`correct`, `incorrect` or `uncertain`) and `why`. The app grades these
deterministically; the harness scores that as the baseline and, if asked, a model's grading for
comparison only.

## Running

```sh
# Plumbing check, no key, no network. Mock results are smoke evidence only.
npm run eval -- --task hint --provider mock
npm run eval -- --provider mock --dir src/test/fixtures/eval-smoke

# A live comparison. Spends free-tier quota, so it needs every one of these:
GEMINI_API_KEY=... npm run eval -- --task hint --provider gemini --live \
  --model <model-id> --max-cases 20 --rpm 10 --out evals/runs/hint-<model>.json
```

A live run prints how many requests to expect before it makes the first one, makes one call at a
time at the pace of `--rpm`, and stops at `--max-requests` (default twice the case count: a
structured call may make one repair retry). A quota error (429) stops the run: the remaining
cases are reported as `unvalidated`, and nothing switches to another model. Exit code 2 means a
run stopped early; 1 means bad input.

`--out` writes each case's result and the model's answer (this stays local; `evals/runs/` is
git-ignored). Check the cases marked `needs_human_review` yourself and record your judgments
in `docs/ai-model.md`.

## What the numbers mean

Metrics are never combined into one score. Each has its own denominator, which only counts the
cases it applies to:

- `answer_correctness`, `citation_validity`, `hint_leakage`, `ambiguity_handling`,
  `rubric_agreement`, `generation_yield`, `false_accept`: counted when a script can decide.
- `step_correctness`, and the semantic part of the others: `needsHumanReview`. These are not
  passes. A person decides.
- Latency and request count are reported next to them, with token counts when Gemini returns them.

An answer the app's own checks would refuse (a hint that states the answer, say) is `withheld`:
the student would have seen nothing. It is reported, not counted as a pass.
