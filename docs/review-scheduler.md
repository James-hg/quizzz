# Review scheduler (policy v1)

When a student should see a question again. The rules are plain functions in
`src/server/scheduler/core.ts` (no database, no clock). `src/server/scheduler/repository.ts`
applies them in the same transaction that stores an attempt. The numbers are product
parameters, not claims about how memory works, and they live in a versioned policy
(`scheduler_policies`, see [learning-schema.md](learning-schema.md)).

## Policy v1

- Intervals after independent success: **1, 3, 7, 14 days**. After the last one, the item keeps
  coming back every 14 days.
- A miss on something already recalled steps back **one** interval (a "lapse"). A first miss
  while still learning is not a lapse.
- A correct answer that used help does **not** move the schedule forward.
- At most **20** reviews are offered per local day (`maxReviewsPerDay`; policy versions stored
  before this existed read as 20).

Change a rule by adding a new policy version, never by editing one in use.

## What counts

Only a **first try, scored** attempt counts (`pass = 1`, `activity_role = scored`).

| Attempt | Effect |
| --- | --- |
| First independent success | Starts the schedule: first check in 1 day |
| Independent success, due, and not seen earlier that local day | Delayed recall: next interval |
| Independent success before it was due | Recorded, schedule unchanged ("recalled early") |
| Success on a day the student already saw the question or its help | Recorded, not delayed recall |
| Correct after a hint, example, or explanation (`assistance_level` other than `none`) | Comes back tomorrow to answer unaided; no advance |
| Wrong | Comes back tomorrow; a lapse if it had been recalled before |
| `uncertain` grading | No change. Never a failure |
| Retry (`pass = 2`), practice, pre-question | No change: the student had already seen a verdict |
| Paused (`suspended`) | No change |

Speed and confidence are never inputs. Questions that cannot be practised (no answer,
excluded, reported, rejected, or awaiting review, using `classifyQuestion`) are not scheduled.

`attempts.assistance_level` is set at submit time from the help recorded for the turn, and the
help events are linked to the attempt.

## Days, timezones, exam date

"Today" is the student's local day (`user.timezone`). A due date is the start of a local day, so
daylight-saving days of 23 or 25 hours need no special case. The last review day is the day
before `courses.exam_date`; nothing is scheduled on or after the exam, and nothing promises that
every item is mastered by then.

## Backlog

`dueItems` returns what is due by the end of the local day, most urgent first: items being
relearned (missed or needed help), then the longest overdue, then by id. Only the first
`maxReviewsPerDay` are offered; the rest are deferred, keep their place and are never marked as
failed, so after 10 missed days the queue is capped and drains over the following days.

## Reasons

Each change stores a sentence in `review_states.last_reason`, for example "You needed a hint
last time, so it comes back tomorrow to answer on your own." or "Recalled on 3 separate days.
Next check in 7 days."
