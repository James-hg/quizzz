/**
 * Plans a short study session from a pool of candidate questions. Pure and deterministic: no
 * database, no clock, no randomness, no model. The numbers are product parameters (versioned by
 * the session's policy version), not claims about learning. The ordering and the reasons are
 * explainable on purpose: a student should be able to see why each kind of question is there.
 */

export type PlannerMode = "review" | "exam";
export const BUDGET_OPTIONS = [5, 10, 20] as const;
export type BudgetMinutes = (typeof BUDGET_OPTIONS)[number];

export type PlannerParams = {
  /** Share of a session kept for new questions when any exist (always at least one slot). */
  newRatio: number;
  /** Assumed seconds per question until there is enough history. Deliberately conservative. */
  defaultSecondsPerItem: number;
  minSecondsPerItem: number;
  maxSecondsPerItem: number;
  /** Completed sessions needed before the estimate uses the student's own pace. */
  minHistorySessions: number;
};

export const PLANNER_V1: PlannerParams = {
  newRatio: 0.25,
  defaultSecondsPerItem: 120,
  minSecondsPerItem: 20,
  maxSecondsPerItem: 600,
  minHistorySessions: 3,
};

/** Parameters for a policy version. Unknown versions fall back to v1. */
export function plannerParamsFor(policyVersion: string): PlannerParams {
  void policyVersion;
  return PLANNER_V1;
}

export type DueInfo = {
  reason: string;
  daysOverdue: number;
  /** Missed, or answered with help: comes back sooner. */
  relearning: boolean;
};

export type Candidate = {
  questionId: string;
  revisionId: string;
  questionSetId: string;
  questionSetTitle: string;
  position: number;
  /** Set only for questions the review scheduler says are due today. */
  due: DueInfo | null;
  /** Scored first tries so far. Zero means the student has never answered it. */
  scoredAttempts: number;
  /** The latest scored first try was wrong. */
  lastFirstTryMissed: boolean;
};

export type PlanInput = {
  candidates: readonly Candidate[];
  mode: PlannerMode;
  budgetMinutes: BudgetMinutes;
  estimatedSecondsPerItem: number;
  params?: PlannerParams;
};

export type Plan = {
  items: { questionId: string; revisionId: string }[];
  estimatedSeconds: number;
  /** Why the session looks the way it does. Never claims everything that is due fits. */
  reasons: string[];
  /** What kept the session at this size: the time budget, or not enough playable questions. */
  limitedBy: "budget" | "content" | null;
  counts: { due: number; new: number; extra: number; dueAvailable: number; newAvailable: number };
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Median of the usable samples, or null when there are none. */
export function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Seconds to allow per question. Starts at a conservative default and moves to the median of the
 * student's own per-session pace once there are enough completed sessions. It is an average per
 * session, not a measured per-question timer, and is clamped so one odd session cannot distort it.
 */
export function estimateSecondsPerItem(
  sessionPaces: readonly number[],
  params: PlannerParams = PLANNER_V1,
): number {
  const usable = sessionPaces.filter((v) => Number.isFinite(v) && v > 0);
  if (usable.length < params.minHistorySessions) return params.defaultSecondsPerItem;
  const m = median(usable)!;
  return Math.round(Math.min(params.maxSecondsPerItem, Math.max(params.minSecondsPerItem, m)));
}

/** How many questions fit: at least one whenever there is something to practise. */
export function capacityFor(
  budgetMinutes: number,
  secondsPerItem: number,
  params: PlannerParams = PLANNER_V1,
): number {
  const seconds = Math.min(
    params.maxSecondsPerItem,
    Math.max(params.minSecondsPerItem, secondsPerItem),
  );
  return Math.max(1, Math.floor((budgetMinutes * 60) / seconds));
}

const bySet = (a: Candidate, b: Candidate) =>
  compare(a.questionSetTitle, b.questionSetTitle) ||
  compare(a.questionSetId, b.questionSetId) ||
  a.position - b.position ||
  compare(a.questionId, b.questionId);

const dueOrder = (a: Candidate, b: Candidate) =>
  Number(b.due!.relearning) - Number(a.due!.relearning) ||
  b.due!.daysOverdue - a.due!.daysOverdue ||
  compare(a.questionId, b.questionId);

const seenOrder = (a: Candidate, b: Candidate) =>
  Number(b.lastFirstTryMissed) - Number(a.lastFirstTryMissed) ||
  a.scoredAttempts - b.scoredAttempts ||
  compare(a.questionId, b.questionId);

function unique(candidates: readonly Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter((c) =>
    seen.has(c.questionId) ? false : (seen.add(c.questionId), true),
  );
}

const pick = (c: Candidate) => ({ questionId: c.questionId, revisionId: c.revisionId });

function finish(
  items: Candidate[],
  eligible: number,
  capacity: number,
  secondsPerItem: number,
  reasons: string[],
  counts: Plan["counts"],
): Plan {
  const limitedBy = eligible > items.length ? "budget" : items.length < capacity ? "content" : null;
  return {
    items: items.map(pick),
    estimatedSeconds: items.length * secondsPerItem,
    reasons,
    limitedBy,
    counts,
  };
}

export function planSession(input: PlanInput): Plan {
  const params = input.params ?? PLANNER_V1;
  const secondsPerItem = Math.round(
    Math.min(
      params.maxSecondsPerItem,
      Math.max(params.minSecondsPerItem, input.estimatedSecondsPerItem),
    ),
  );
  const capacity = capacityFor(input.budgetMinutes, secondsPerItem, params);
  const candidates = unique(input.candidates);
  const pace = `about ${secondsPerItem} seconds each`;

  if (input.mode === "exam") return planExam(candidates, input, capacity, secondsPerItem);

  const due = candidates.filter((c) => c.due).sort(dueOrder);
  const fresh = candidates.filter((c) => !c.due && c.scoredAttempts === 0).sort(bySet);
  const seen = candidates.filter((c) => !c.due && c.scoredAttempts > 0).sort(seenOrder);
  const eligible = due.length + fresh.length + seen.length;
  const counts = {
    due: 0,
    new: 0,
    extra: 0,
    dueAvailable: due.length,
    newAvailable: fresh.length,
  };

  if (eligible === 0) {
    return finish(
      [],
      0,
      capacity,
      secondsPerItem,
      ["There are no playable questions in this course yet."],
      counts,
    );
  }

  // Keep room for new learning so reviews cannot crowd it out entirely.
  const newSlots =
    fresh.length > 0 && capacity >= 2
      ? Math.min(fresh.length, Math.max(1, Math.floor(capacity * params.newRatio)))
      : 0;
  const takeDue = due.slice(0, capacity - newSlots);
  const takeNew = fresh.slice(0, capacity - takeDue.length);
  const takeSeen = seen.slice(0, capacity - takeDue.length - takeNew.length);
  counts.due = takeDue.length;
  counts.new = takeNew.length;
  counts.extra = takeSeen.length;

  const reasons: string[] = [];
  if (due.length > 0) {
    reasons.push(
      takeDue.length < due.length
        ? `${takeDue.length} of your ${due.length} due questions fit in ${input.budgetMinutes} minutes (${pace}). The other ${due.length - takeDue.length} stay due and come back next time.`
        : `${plural(due.length, "question is", "questions are")} due for review (${pace}).`,
    );
    reasons.push(
      "Most urgent first: questions you missed or needed help with, then the longest overdue.",
    );
  } else {
    reasons.push("Nothing is due for review today.");
  }
  if (takeNew.length > 0) {
    reasons.push(
      newSlots > 0 && due.length > capacity - newSlots
        ? `${plural(takeNew.length, "slot is", "slots are")} kept for new questions so reviews do not crowd out new learning.`
        : `${plural(takeNew.length, "new question", "new questions")} you have not answered yet.`,
    );
  }
  if (takeSeen.length > 0) {
    reasons.push(
      `${plural(takeSeen.length, "extra practice question", "extra practice questions")} you have seen before, starting with ones you missed.`,
    );
  }
  const plan = finish(
    [...takeDue, ...takeNew, ...takeSeen],
    eligible,
    capacity,
    secondsPerItem,
    reasons,
    counts,
  );
  if (plan.limitedBy === "content") {
    plan.reasons.push(
      `Only ${plural(plan.items.length, "question", "questions")} can be practised right now, fewer than fit in ${input.budgetMinutes} minutes.`,
    );
  }
  return plan;
}

/** Practice exam: a spread across the course's question sets, with no scheduling logic. */
function planExam(
  candidates: Candidate[],
  input: PlanInput,
  capacity: number,
  secondsPerItem: number,
): Plan {
  const counts = { due: 0, new: 0, extra: 0, dueAvailable: 0, newAvailable: 0 };
  const groups = new Map<string, Candidate[]>();
  for (const c of [...candidates].sort(bySet)) {
    groups.set(c.questionSetId, [...(groups.get(c.questionSetId) ?? []), c]);
  }
  // Take one from each question set in turn so the exam covers the course.
  const queues = [...groups.values()];
  const items: Candidate[] = [];
  for (let round = 0; items.length < capacity; round++) {
    let added = false;
    for (const queue of queues) {
      const next = queue[round];
      if (next && items.length < capacity) {
        items.push(next);
        added = true;
      }
    }
    if (!added) break;
  }
  if (candidates.length === 0) {
    return finish(
      [],
      0,
      capacity,
      secondsPerItem,
      ["There are no playable questions in this course yet."],
      counts,
    );
  }
  const reasons = [
    `Practice exam: ${plural(items.length, "question", "questions")} from ${plural(groups.size, "question set", "question sets")}, spread across the course. No hints, and results only at the end. It is practice, not an official assessment.`,
  ];
  const plan = finish(items, candidates.length, capacity, secondsPerItem, reasons, counts);
  if (plan.limitedBy === "budget") {
    plan.reasons.push(
      `${items.length} of ${candidates.length} questions fit in ${input.budgetMinutes} minutes.`,
    );
  } else if (plan.limitedBy === "content") {
    plan.reasons.push(
      `Only ${plural(items.length, "question", "questions")} can be practised right now, fewer than fit in ${input.budgetMinutes} minutes.`,
    );
  }
  return plan;
}
