# AI model selection

Checked on **2026-10-19** against the official pages
([pricing](https://ai.google.dev/gemini-api/docs/pricing),
[rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)).

## Configuration

| Variable | Meaning |
| --- | --- |
| `AI_PROVIDER` | `gemini` or `disabled` (default). `gemini` without a key behaves as disabled. |
| `GEMINI_API_KEY` | Server-only. Sent in the `x-goog-api-key` header, never in a URL, never logged. |
| `GEMINI_MODEL` | Model id. Defaults to `gemini-2.5-flash` when unset. |
| `AI_REQUESTS_PER_HOUR` | Per-user cap on AI calls (default 30). |

There is no automatic switch to a paid model. When the free quota is used up the routes return
`429 ai_quota_exceeded` and normal practice keeps working.

## Free-tier text models seen on 2026-10-19

Free input and output on the Standard free tier: `gemini-3.8-flash`, `gemini-3.6-flash`,
`gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-2.5-pro`, `gemini-2.5-flash`,
`gemini-2.5-flash-lite`, and `gemini-3-flash-preview` (preview). `gemini-3.1-pro-preview` has no
free tier. The pricing page does not publish per-model free limits; they are shown per project
in Google AI Studio (limits are per project, not per key, and daily quotas reset at midnight
Pacific).

## Default: `gemini-2.5-flash`

A provisional default, chosen because it is free, not labeled preview, and a stronger general
model than the Lite variants. It is **not** a measured choice. The final model per feature is
picked in the evaluation harness (issue B8) by comparing free models on the checked content set,
and a feature whose quality gate no free model meets is withheld rather than shipped on a weaker
model. The old `gemini-2.0-flash` default is intentionally not carried forward.

## Request format

Calls use the REST `generateContent` endpoint through `fetch`. Structured output asks for
`responseMimeType: application/json`, includes the JSON Schema in the system instruction, and
validates the reply with Zod. An invalid reply gets exactly one repair retry (the validation
error is sent back), then fails with `502 ai_invalid_output`. The schema is deliberately not sent
in a provider-specific schema field, so unsupported schema keywords can never reject a request.

## Error mapping

| Situation | Response |
| --- | --- |
| Disabled, no key, bad key/model, network error, 5xx | `503 ai_unavailable` |
| Gemini HTTP 429 | `429 ai_quota_exceeded` |
| Deadline exceeded (default 30 s per call, including the repair retry) | `504 ai_timeout` |
| Unusable output twice, blocked or empty answer | `502 ai_invalid_output` |
| Per-user hourly cap | `429 ai_rate_limited` |

## Evaluation harness (B8)

`npm run eval` runs checked cases through the app's own prompts and output checks (the tutor's
`buildPrompt` and `shapeOutput`, question generation's `proposeQuestions`, and the deterministic
grader), so it measures the system the app runs, not a copy of it. How to write cases and run it
is in [`evals/README.md`](../evals/README.md).

**Status on 2026-11-01: the harness is built; no model has been evaluated and no default has
been chosen.** `evals/` has no checked cases yet (they must be checked by the owner; the
AI-drafted sample courses are not), and no live run has been made. So every task below is
**unvalidated**, `gemini-2.5-flash` stays a provisional default, and no feature is yet declared
withheld or released on the strength of a measurement.

| Task | Checked cases | Live results | Decision |
| --- | --- | --- | --- |
| Hints (`small_hint`, `why_wrong`) | 0 | none | unvalidated |
| Explanations | 0 | none | unvalidated |
| Question generation | 0 | none | unvalidated |
| Short-answer grading (research only: the app grades deterministically) | 0 | none | unvalidated |

### Gates, set before any live result

These are proposed now so they cannot be fitted to results. The owner may change them before the
first live run; after that, changing one means saying so here. A model passes a task only if it
meets every gate on the checked set for that task and language, with no case lost to quota.

- **Hard gates (zero tolerance):** no fabricated or disallowed citation (`citation_validity` has
  no failures); no hint that states the answer after the app's own check (`hint_leakage` has no
  failures); no known wrong answer in a checked explanation (`answer_correctness` has no
  failures); no wrongly accepted answer in grading (`false_accept` has no failures).
- **Rates:** at least 90% on `ambiguity_handling` for cases tagged `ambiguous` or
  `missing_source`; `generation_yield` of at least 80%; and at least 90% of the cases a person
  reviewed for steps and rubric judged acceptable.
- **Coverage:** at least 20 checked cases per task and language, including every tag that applies
  (missing source, misleading key, ambiguous, prompt injection, alternative valid answer). Fewer
  than that is reported as unvalidated, not as a pass. A finite set does not prove accuracy in
  general; the results say how a model did on these cases.
- If no free model meets a task's gates, that feature is withheld and practice keeps working
  without it.

### Limitations

- Mock results (`evidence: "smoke"`) only show the harness runs; CI runs it for that reason.
- The script cannot judge meaning. Step correctness, source support and whether an answer is
  right are marked `needs_human_review` and need a person who did not write the case with the
  model's help. Agreement between two models is not ground truth.
- Token counts appear only when Gemini returns them; request counts include repair retries.
- Free-tier limits are per project and change. Re-check the pricing and rate-limit pages on the
  day of a live run, record the date and the models seen, and exclude a model that is no longer
  free rather than paying for it.
- Re-run after any change to a prompt version (`tutor-v1`, `generate-v1`), the content-check
  validator version, or the checked set. Each run records those, the fixture hash and the commit.
