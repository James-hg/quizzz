/**
 * The single definition of "can this question be practised, and if not, why". Used by the
 * server (counts, session start) and the browser (editor filter), so they cannot disagree.
 * `listPlayableItems` filters in SQL with `PLAY_BLOCKING_EVIDENCE`; a test keeps both in step.
 */

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
  if (q.status === "active" && !blocked) return "playable";
  if ((REVIEW_BLOCKING_EVIDENCE as readonly string[]).includes(q.evidenceStatus)) {
    return "needs_review";
  }
  if (q.answerKind === "unresolved") return "no_answer";
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
