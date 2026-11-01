/**
 * What review state a revision gets when an owner creates or edits a question.
 *
 * - A question the owner writes themselves (origin `original`) with a resolved answer is
 *   `human_reviewed`: they are the reviewer. `unresolved` is only for a missing answer.
 * - Anything that did not come from the owner (AI-proposed, AI-variant, sample) needs an explicit
 *   approve before it counts as reviewed, and editing it never skips that step.
 */

export type EvidenceState =
  | "unresolved"
  | "generated_unreviewed"
  | "source_linked"
  | "deterministically_checked"
  | "human_reviewed"
  | "needs_review"
  | "rejected";

/** States that stay as they are when a non-original question is edited without approval. */
const KEEP_UNTIL_APPROVED: readonly EvidenceState[] = [
  "generated_unreviewed",
  "needs_review",
  "rejected",
];

export type EvidenceInput = {
  /** `question_revisions.origin` of the revision being written. */
  origin: string;
  /** `answerKey.kind` of the revision being written. */
  answerKind: string;
  /** The owner's explicit approve tick. Only matters for non-original origins. */
  approve: boolean;
  /** The evidence state of the revision being replaced, if any. */
  previous?: EvidenceState;
  /** The owner rejects this content. Wins over everything except a missing answer. */
  reject?: boolean;
};

export function evidenceFor({
  origin,
  answerKind,
  approve,
  previous,
  reject,
}: EvidenceInput): EvidenceState {
  if (answerKind === "unresolved") return "unresolved";
  if (reject) return "rejected";
  if (origin === "original") return "human_reviewed";
  if (approve) return "human_reviewed";
  if (previous && KEEP_UNTIL_APPROVED.includes(previous)) return previous;
  // Content changed after it had been checked (or there is no earlier state): check it again.
  return "needs_review";
}
