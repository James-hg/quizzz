# Draft evaluation cases (unchecked)

These cases were **drafted by an AI model** for the owner to check. They have no `review`, carry
`"kind": "draft"`, and say in `draftNotes` what to verify. Until a person checks them they are
not evidence of anything:

- `npm run eval` on `evals/` never loads this folder.
- A live Gemini run refuses any draft.
- `npm run eval -- --provider mock --dir evals/drafts` only checks that the drafts are well formed.

## Python (80 drafts, 20 per task)

| Task | File | Tags covered |
| --- | --- | --- |
| Hints | `python/hint.jsonl` | missing source, retry protected, prompt injection, ambiguous, edge cases |
| Explanations | `python/explanation.jsonl` | missing source, misleading key, prompt injection, ambiguous, alternative answer, edge cases |
| Question generation | `python/question_generation.jsonl` | prompt injection, ambiguous, out-of-date topic, edge cases |
| Short-answer grading | `python/short_answer_grading.jsonl` | alternative valid answers, ambiguous layout, prompt injection, edge cases |

The source passages are short synthetic notes written for these drafts, not course material.
Four grading drafts (03, 05, 18, 19) are answers a person would accept but the app's exact-match
grader rejects. They are there to show where the deterministic grader is strict; decide whether
each answer really should count.

## Promoting a draft to a checked case

For each line you accept:

1. Check the question, the key and every expected string. Run the code if there is any. Fix
   anything wrong; change `draftNotes` concerns into fixes, not comments.
2. Remove `draftNotes`, set `"kind": "checked"`, and add your review:
   `"review": { "checkedBy": "<your name>", "checkedAt": "YYYY-MM-DD", "rationale": "<why the expected answer is right>" }`.
3. Move the line to `evals/python/<task>.jsonl` (same file name). Delete it here.
4. Run `npm run eval -- --task <task> --provider mock` to confirm the checked set still loads.

Do not promote a case you have not checked yourself, and never let a model fill in `review`.
Lines you reject can simply be deleted.
