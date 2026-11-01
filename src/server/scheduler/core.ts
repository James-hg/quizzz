import { classifyQuestion } from "@/lib/playability";
import type { ReviewState } from "@/lib/schemas";
import { addDays, daysBetween, localDate, startOfLocalDay } from "./dates";
import type { SchedulerPolicy } from "./policy";

/**
 * The review scheduler's rules, as pure functions: no database, no clock, no randomness. The
 * caller passes `now`, the student's timezone and the exam date, so the same inputs always give
 * the same schedule. The numbers come from a versioned policy and are product parameters, not
 * claims about how memory works.
 */

export type ReviewSnapshot = {
  state: ReviewState;
  /** Which interval the student is working towards (index into the policy's intervals). */
  stepIndex: number;
  nextDueAt: Date | null;
  lastIndependentSuccessAt: Date | null;
  delayedSuccessCount: number;
  distinctSuccessDays: number;
  lapses: number;
};

export const NEW_REVIEW_STATE: ReviewSnapshot = {
  state: "new",
  stepIndex: 0,
  nextDueAt: null,
  lastIndependentSuccessAt: null,
  delayedSuccessCount: 0,
  distinctSuccessDays: 0,
  lapses: 0,
};

export type AttemptFacts = {
  outcome: "correct" | "incorrect" | "uncertain";
  /** 1 = first try, 2 = the retry that follows a verdict the student already saw. */
  pass: number;
  activityRole: "scored" | "prequestion" | "practice";
  /** The strongest help used before answering. */
  assistance:
    | "none"
    | "conceptual_hint"
    | "next_step_hint"
    | "partial_example"
    | "full_explanation"
    | "solution_revealed";
  /** The latest earlier attempt or help event for this question, if any. */
  lastExposureAt: Date | null;
};

export type Applied = {
  state: ReviewSnapshot;
  /** Plain language, shown to the student as the reason for the schedule. */
  reason: string;
  changed: boolean;
};

/**
 * When to ask again, `days` local days from today, never later than the day before the exam.
 * Null means there is nothing left to schedule: the exam is today or past, or the only day
 * left to review has gone.
 */
export function dueAfter(
  now: Date,
  days: number,
  tz: string,
  examDate: string | null,
): Date | null {
  const today = localDate(now, tz);
  let target = addDays(today, days);
  if (examDate) {
    if (today >= examDate) return null;
    const lastReviewDay = addDays(examDate, -1);
    if (lastReviewDay <= today) return null;
    if (target > lastReviewDay) target = lastReviewDay;
  }
  return startOfLocalDay(target, tz);
}

const unchanged = (state: ReviewSnapshot, reason: string): Applied => ({
  state,
  reason,
  changed: false,
});

function helpWords(assistance: AttemptFacts["assistance"]) {
  return assistance === "solution_revealed" ? "You saw the solution first" : "You needed a hint";
}

export function applyAttempt(
  state: ReviewSnapshot,
  attempt: AttemptFacts,
  policy: SchedulerPolicy,
  now: Date,
  tz: string,
  examDate: string | null,
): Applied {
  if (state.state === "suspended") {
    return unchanged(state, "Reviews of this question are paused.");
  }
  if (attempt.outcome === "uncertain") {
    return unchanged(state, "This answer could not be checked, so your schedule did not change.");
  }
  // Only a first, scored try is independent evidence. A retry follows a verdict the student
  // has seen, and a pre-question is asked before learning.
  if (attempt.activityRole !== "scored" || attempt.pass !== 1) {
    return unchanged(state, "Practice after seeing the answer does not change your schedule.");
  }

  const today = localDate(now, tz);
  const intervals = policy.intervalsDays;
  const last = intervals.length - 1;
  const assisted =
    attempt.assistance === "solution_revealed" ||
    (attempt.assistance !== "none" && !policy.assistedAdvances);
  const tomorrow = dueAfter(now, 1, tz, examDate);

  if (attempt.outcome === "incorrect") {
    // A first miss while still learning is not a lapse; a miss on something already recalled is.
    const lapsed = state.lastIndependentSuccessAt !== null;
    return {
      changed: true,
      state: {
        ...state,
        state: "learning",
        stepIndex: lapsed ? Math.max(0, state.stepIndex - policy.onLapse.stepBack) : 0,
        nextDueAt: tomorrow,
        lapses: state.lapses + (lapsed ? 1 : 0),
      },
      reason: tomorrow
        ? "You missed this, so it comes back tomorrow."
        : "You missed this, and there is no review day left before your exam.",
    };
  }

  if (assisted) {
    // Correct, but with help: useful, different evidence. It does not move the schedule up.
    return {
      changed: true,
      state: {
        ...state,
        state: "learning",
        nextDueAt: tomorrow,
      },
      reason: `${helpWords(attempt.assistance)} last time, so it comes back tomorrow to answer on your own.`,
    };
  }

  const newDay =
    !state.lastIndependentSuccessAt || localDate(state.lastIndependentSuccessAt, tz) !== today;
  const distinctSuccessDays = state.distinctSuccessDays + (newDay ? 1 : 0);

  // The first independent success starts the schedule.
  if (!state.lastIndependentSuccessAt) {
    const due = dueAfter(now, intervals[0]!, tz, examDate);
    return {
      changed: true,
      state: {
        ...state,
        state: "reviewing",
        stepIndex: 0,
        nextDueAt: due,
        lastIndependentSuccessAt: now,
        distinctSuccessDays,
      },
      reason: due
        ? `Recalled on your own. First check in ${intervals[0]} ${intervals[0] === 1 ? "day" : "days"}.`
        : "Recalled on your own. No review day is left before your exam.",
    };
  }

  // A later success counts as delayed recall only when it is due and the student has not seen
  // this question (or its answer) earlier the same day.
  const isDue = !state.nextDueAt || now >= state.nextDueAt;
  const freshToday = !attempt.lastExposureAt || localDate(attempt.lastExposureAt, tz) < today;
  if (!isDue || !freshToday) {
    return {
      changed: true,
      state: { ...state, lastIndependentSuccessAt: now, distinctSuccessDays },
      reason: isDue
        ? "Recalled, but you saw this earlier today, so it does not count as a delayed check."
        : "Recalled early. Your next check stays as planned.",
    };
  }

  const stepIndex = Math.min(state.stepIndex + 1, last);
  const due = dueAfter(now, intervals[stepIndex]!, tz, examDate);
  return {
    changed: true,
    state: {
      ...state,
      state: "reviewing",
      stepIndex,
      nextDueAt: due,
      lastIndependentSuccessAt: now,
      delayedSuccessCount: state.delayedSuccessCount + 1,
      distinctSuccessDays,
    },
    reason: `Recalled on ${distinctSuccessDays} separate ${distinctSuccessDays === 1 ? "day" : "days"}. ${
      due
        ? `Next check in ${intervals[stepIndex]} ${intervals[stepIndex] === 1 ? "day" : "days"}.`
        : "No review day is left before your exam."
    }`,
  };
}

export type ReviewItem = ReviewSnapshot & { questionId: string };

export type DueItem = {
  questionId: string;
  dueAt: Date;
  daysOverdue: number;
  reason: string;
};

export type DueResult = {
  /** What to offer today, most urgent first, at most `maxReviewsPerDay`. */
  today: DueItem[];
  /** Also due, but pushed to later days. Not failed: they keep their place. */
  deferred: DueItem[];
};

/**
 * Items due on the student's local day. A backlog is capped to the policy's daily limit, most
 * urgent first: questions being relearned before ones that were recalled, then the longest
 * overdue. The order is fully determined (ties broken by question id).
 */
export function dueItems(
  items: readonly ReviewItem[],
  now: Date,
  tz: string,
  examDate: string | null,
  policy: SchedulerPolicy,
): DueResult {
  const today = localDate(now, tz);
  if (examDate && today >= examDate) return { today: [], deferred: [] };
  const endOfToday = startOfLocalDay(addDays(today, 1), tz);

  const due = items
    .filter((i) => i.state !== "suspended" && i.state !== "new" && i.nextDueAt)
    .filter((i) => i.nextDueAt! < endOfToday)
    .map((i) => {
      const daysOverdue = Math.max(0, daysBetween(localDate(i.nextDueAt!, tz), today));
      const relearning = i.state === "learning";
      const reason = relearning
        ? "You missed it or needed help last time."
        : daysOverdue === 0
          ? "Due today."
          : `Due ${daysOverdue} ${daysOverdue === 1 ? "day" : "days"} ago.`;
      return { item: i, daysOverdue, relearning, reason };
    })
    .sort(
      (a, b) =>
        Number(b.relearning) - Number(a.relearning) ||
        b.daysOverdue - a.daysOverdue ||
        a.item.nextDueAt!.getTime() - b.item.nextDueAt!.getTime() ||
        (a.item.questionId < b.item.questionId ? -1 : 1),
    )
    .map((d): DueItem => ({
      questionId: d.item.questionId,
      dueAt: d.item.nextDueAt!,
      daysOverdue: d.daysOverdue,
      reason: d.reason,
    }));

  return {
    today: due.slice(0, policy.maxReviewsPerDay),
    deferred: due.slice(policy.maxReviewsPerDay),
  };
}

/** Whether a question may be scheduled at all: the same rule as practice. */
export function isSchedulable(q: {
  status: string;
  evidenceStatus: string;
  answerKind: string;
}): boolean {
  return classifyQuestion(q) === "playable";
}
