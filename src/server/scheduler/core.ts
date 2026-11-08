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
  /**
   * The next check by the interval alone, with no exam involved. It is stored this way so moving
   * or clearing the exam date needs no rewrite: `effectiveDueAt` applies the exam when it is read.
   * Null for `new` rows.
   */
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
  /** When the stored next check was last set (the review state's last update), if known. */
  scheduleSetAt?: Date | null;
};

export type Applied = {
  state: ReviewSnapshot;
  /** Plain language, shown to the student as the reason for the schedule. */
  reason: string;
  changed: boolean;
};

/** The start of the local day `days` days from today: the normal interval, whatever the exam. */
export function dueAfter(now: Date, days: number, tz: string): Date {
  return startOfLocalDay(addDays(localDate(now, tz), days), tz);
}

/** Whether an exam date still limits the schedule. On or after exam day it no longer does. */
export function examIsUpcoming(examDate: string | null, now: Date, tz: string): examDate is string {
  return examDate !== null && localDate(now, tz) < examDate;
}

/**
 * The due date to act on, given the exam. Reviews never land on or after exam day while it is
 * upcoming: a later date moves to the day before the exam, and when that day is today (the exam
 * is tomorrow) a check set on or after that day has nowhere to go and the result is null. A check
 * set earlier is simply due on that last day, and one that is already due stays due. Once the exam
 * date has come, it is ignored and the normal date holds.
 */
export function effectiveDueAt(
  normalDueAt: Date,
  now: Date,
  tz: string,
  examDate: string | null,
  scheduledAt: Date | null = null,
): Date | null {
  if (!examIsUpcoming(examDate, now, tz)) return normalDueAt;
  const lastReviewDay = addDays(examDate, -1);
  if (localDate(normalDueAt, tz) <= lastReviewDay) return normalDueAt;
  if (scheduledAt && localDate(scheduledAt, tz) >= lastReviewDay) return null;
  return startOfLocalDay(lastReviewDay, tz);
}

function checkIn(days: number) {
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** "Next check in 3 days." and what changes when the exam is close. */
function nextCheckText(days: number, normal: Date, effective: Date | null, tz: string) {
  if (!effective) return "No review day is left before your exam.";
  if (effective.getTime() === normal.getTime()) return `Next check in ${checkIn(days)}.`;
  return `Next check on ${localDate(effective, tz)}, the last review day before your exam.`;
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
  const tomorrow = dueAfter(now, 1, tz);
  const tomorrowEffective = effectiveDueAt(tomorrow, now, tz, examDate, now);

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
      reason: tomorrowEffective
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
    const normal = dueAfter(now, intervals[0]!, tz);
    const due = effectiveDueAt(normal, now, tz, examDate, now);
    return {
      changed: true,
      state: {
        ...state,
        state: "reviewing",
        stepIndex: 0,
        nextDueAt: normal,
        lastIndependentSuccessAt: now,
        distinctSuccessDays,
      },
      reason: `Recalled on your own. ${
        due && due.getTime() === normal.getTime()
          ? `First check in ${checkIn(intervals[0]!)}.`
          : nextCheckText(intervals[0]!, normal, due, tz)
      }`,
    };
  }

  // A later success counts as delayed recall only when it is due and the student has not seen
  // this question (or its answer) earlier the same day.
  const dueNow = state.nextDueAt
    ? effectiveDueAt(state.nextDueAt, now, tz, examDate, attempt.scheduleSetAt ?? null)
    : null;
  const isDue = !state.nextDueAt || (dueNow !== null && now >= dueNow);
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
  const normal = dueAfter(now, intervals[stepIndex]!, tz);
  const due = effectiveDueAt(normal, now, tz, examDate, now);
  return {
    changed: true,
    state: {
      ...state,
      state: "reviewing",
      stepIndex,
      nextDueAt: normal,
      lastIndependentSuccessAt: now,
      delayedSuccessCount: state.delayedSuccessCount + 1,
      distinctSuccessDays,
    },
    reason: `Recalled on ${distinctSuccessDays} separate ${distinctSuccessDays === 1 ? "day" : "days"}. ${nextCheckText(
      intervals[stepIndex]!,
      normal,
      due,
      tz,
    )}`,
  };
}

export type ReviewItem = ReviewSnapshot & {
  questionId: string;
  /** When `nextDueAt` was last set; lets a just-scheduled check be told from an older one. */
  scheduledAt?: Date | null;
};

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
  const endOfToday = startOfLocalDay(addDays(today, 1), tz);

  const due = items
    .filter((i) => i.state !== "suspended" && i.state !== "new" && i.nextDueAt)
    .map((i) => ({
      ...i,
      dueAt: effectiveDueAt(i.nextDueAt!, now, tz, examDate, i.scheduledAt ?? null),
    }))
    .filter((i): i is typeof i & { dueAt: Date } => i.dueAt !== null && i.dueAt < endOfToday)
    .map((i) => {
      const daysOverdue = Math.max(0, daysBetween(localDate(i.dueAt, tz), today));
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
        a.item.dueAt.getTime() - b.item.dueAt.getTime() ||
        (a.item.questionId < b.item.questionId ? -1 : 1),
    )
    .map((d): DueItem => ({
      questionId: d.item.questionId,
      dueAt: d.item.dueAt,
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
