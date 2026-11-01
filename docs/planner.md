# Session planner (policy v1)

"Start today's session" for a course. The planner is a pure function in
`src/server/planner/index.ts` (no database, no clock, no model). `src/server/planner/queries.ts`
loads the inputs and `src/server/sessions/course-session.ts` stores the result as a normal
study session with its questions pinned.

## Inputs

- **Playable questions** of the course, using the same definition as quiz sessions
  (`src/lib/playability.ts`): excluded, unreviewed, and answerless questions are never planned.
- **Due items** from the review scheduler ([review-scheduler.md](review-scheduler.md)), already
  capped at 20 a day. Items past the cap are *deferred*, not failed.
- **Pace**: 120 seconds per question until the student has at least 3 finished sessions, then
  the median of their own per-session pace. Conservative on purpose, so a plan is not too long.
- **Time budget**: 5, 10 or 20 minutes. `capacity = floor(budget seconds / seconds per item)`.

## Review sessions

1. Due items first: questions in relearning, then the longest overdue.
2. A share of the capacity (25%, at least one slot once capacity is 2 or more) is kept for new
   questions, so a backlog cannot crowd out new learning.
3. New questions in question-set and position order.
4. Spare room is filled with questions the student has seen, missed ones first.

The reasons returned with a plan say what was chosen and why. They never claim that all due
items fit when they do not ("4 of your 20 due questions fit in 10 minutes ... the other 16 stay
due"). `limitedBy` is `budget` when the budget cut the plan and `content` when the course ran
out of questions.

## Exam sessions

A practice exam spreads questions round-robin across the course's question sets. It uses
`revealMode: "end"`: no correctness is shown until the session ends. Help is turned off: the
guard `assertHelpAllowed` (`src/server/sessions/guards.ts`) returns `403 help_disabled_in_exam`
and must be called by the help route. Finishing early reveals results, like any ended session.
Exams do not change the review schedule differently from other sessions: the scheduler only
reacts to scored first tries.

## Time budget

Only active time counts (paused time does not). The answer in progress is always kept. The
session completes after the answer that uses up the budget (`sessionEnded: true`); questions not
reached stay unanswered and, if they were due, stay due. The budget is an elapsed-time rule,
not a hard deadline on the client.

## One live session per kind

A student can have one live (active or paused) review session and one live exam per course,
enforced by a partial unique index (migration `0012`). Starting again resumes the live one and
keeps its budget and questions.

## Results

`GET /api/sessions/:id/results` (after the session ends) counts unique questions and attempts
separately, splits first tries into independent, assisted, incorrect and unchecked, reports
retries, whether questions were original or generated (read from the revision that was
answered), the question sets that need practice, and the next planned review.
