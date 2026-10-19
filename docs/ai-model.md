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
