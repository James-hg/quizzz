/**
 * The single definition of "can this question be practised, and if not, why". Used by the
 * server (counts, session start) and the browser (editor filter), so they cannot disagree.
 * `listPlayableItems` filters in SQL with `PLAY_BLOCKING_EVIDENCE` and the answer kind; a test
 * keeps both in step.
 *
 * "Unresolved" means the answer is missing (`answerKey.kind === "unresolved"`). The evidence
 * label `unresolved` is not what blocks practice: a question the owner wrote with an answer is
 * reviewed, and one stored with the old label still plays.
 */

/** `answerKey.kind` of a question that has no usable answer yet. */
export const NO_ANSWER_KIND = "unresolved";

/** Evidence states that keep a question out of practice. */
export const REVIEW_BLOCKING_EVIDENCE = ["needs_review", "generated_unreviewed"] as const;
export const PLAY_BLOCKING_EVIDENCE = ["rejected", ...REVIEW_BLOCKING_EVIDENCE] as const;

export type Playability = "playable" | "needs_review" | "no_answer" | "excluded";

export type PlayabilityInput = {
  status: string;
  evidenceStatus: string;
  /** `answerKey.kind` of the current revision. */
  answerKind: string;
};

/**
 * Mutually exclusive, in this order: playable; waiting for the owner to review it; has no
 * answer yet; otherwise excluded (owner-excluded, reported or rejected).
 */
export function classifyQuestion(q: PlayabilityInput): Playability {
  const blocked = (PLAY_BLOCKING_EVIDENCE as readonly string[]).includes(q.evidenceStatus);
  if (q.status === "active" && !blocked && q.answerKind !== NO_ANSWER_KIND) return "playable";
  if ((REVIEW_BLOCKING_EVIDENCE as readonly string[]).includes(q.evidenceStatus)) {
    return "needs_review";
  }
  if (q.answerKind === NO_ANSWER_KIND) return "no_answer";
  return "excluded";
}

export type PlayabilityCounts = {
  total: number;
  playable: number;
  needsReview: number;
  noAnswer: number;
  excluded: number;
};

export function emptyCounts(): PlayabilityCounts {
  return { total: 0, playable: 0, needsReview: 0, noAnswer: 0, excluded: 0 };
}

export function countPlayability(items: readonly PlayabilityInput[]): PlayabilityCounts {
  const counts = emptyCounts();
  for (const item of items) {
    counts.total += 1;
    switch (classifyQuestion(item)) {
      case "playable":
        counts.playable += 1;
        break;
      case "needs_review":
        counts.needsReview += 1;
        break;
      case "no_answer":
        counts.noAnswer += 1;
        break;
      case "excluded":
        counts.excluded += 1;
        break;
    }
  }
  return counts;
}

/**
 * Why nothing can be practised, in plain words. Built from server counts so the browser never
 * guesses. Returns null when something is playable.
 */
export function explainNotPlayable(counts: PlayabilityCounts): string | null {
  if (counts.playable > 0) return null;
  if (counts.total === 0) return "This set has no questions yet.";
  const { total, needsReview, noAnswer, excluded } = counts;
  if (needsReview === total) {
    return total === 1
      ? "The question needs review before it can be practised."
      : `All ${total} questions need review before they can be practised.`;
  }
  if (noAnswer === total) return "No questions with an answer yet.";
  if (excluded === total) return "All questions are excluded from practice.";
  const parts = [
    needsReview > 0 ? `${needsReview} need review` : null,
    noAnswer > 0 ? `${noAnswer} ${noAnswer === 1 ? "has" : "have"} no answer yet` : null,
    excluded > 0 ? `${excluded} excluded` : null,
  ].filter(Boolean);
  return `None of the ${total} questions can be practised yet: ${parts.join(", ")}.`;
}

/** Editor filter, as used in the `?filter=` URL parameter. */
export const QUESTION_FILTERS = ["all", "needs-review", "no-answer", "excluded"] as const;
export type QuestionFilter = (typeof QUESTION_FILTERS)[number];

export function parseFilter(value: string | string[] | undefined): QuestionFilter {
  const first = Array.isArray(value) ? value[0] : value;
  return (QUESTION_FILTERS as readonly string[]).includes(first ?? "")
    ? (first as QuestionFilter)
    : "all";
}

const FILTER_CLASS: Record<Exclude<QuestionFilter, "all">, Playability> = {
  "needs-review": "needs_review",
  "no-answer": "no_answer",
  excluded: "excluded",
};

export function matchesFilter(filter: QuestionFilter, q: PlayabilityInput): boolean {
  return filter === "all" || classifyQuestion(q) === FILTER_CLASS[filter];
}

/** The most useful filter to open when nothing can be practised. */
export function filterToFix(counts: PlayabilityCounts): QuestionFilter {
  if (counts.needsReview > 0) return "needs-review";
  if (counts.noAnswer > 0) return "no-answer";
  if (counts.excluded > 0) return "excluded";
  return "all";
}

export function editorHref(questionSetId: string, filter: QuestionFilter): string {
  return `/question-sets/${questionSetId}/edit${filter === "all" ? "" : `?filter=${filter}`}`;
}

/** Reads the counts the server attaches to a `no_playable_questions` error, or null. */
export function countsFromDetails(details: unknown): PlayabilityCounts | null {
  if (typeof details !== "object" || details === null) return null;
  const d = details as Record<string, unknown>;
  const keys = ["total", "playable", "needsReview", "noAnswer", "excluded"] as const;
  if (!keys.every((k) => typeof d[k] === "number" && Number.isFinite(d[k]))) return null;
  return {
    total: d.total as number,
    playable: d.playable as number,
    needsReview: d.needsReview as number,
    noAnswer: d.noAnswer as number,
    excluded: d.excluded as number,
  };
}
