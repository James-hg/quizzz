import { z } from "zod";
import type { QuestionContent } from "@/lib/schemas";

/** How an existing question can be rewritten by the assistant. */
export const REWRITE_MODES = ["rephrase", "vary_numbers", "add_explanation"] as const;
export const rewriteModeSchema = z.enum(REWRITE_MODES);
export type RewriteMode = z.infer<typeof rewriteModeSchema>;

export const REWRITE_MODE_LABELS: Record<RewriteMode, string> = {
  rephrase: "Rephrase",
  vary_numbers: "Vary numbers",
  add_explanation: "Add explanation",
};

/** Where a proposal comes from and how far it is from being trusted. */
export function provenanceFor(mode: RewriteMode): {
  origin: "ai_variant" | "ai_proposed";
  evidenceStatus: "generated_unreviewed" | "needs_review";
} {
  switch (mode) {
    case "rephrase":
      return { origin: "ai_variant", evidenceStatus: "generated_unreviewed" };
    case "add_explanation":
      return { origin: "ai_proposed", evidenceStatus: "generated_unreviewed" };
    case "vary_numbers":
      // The answer was worked out by the model. Until it can be checked deterministically
      // (Phase D), it always needs a person to confirm it.
      return { origin: "ai_variant", evidenceStatus: "needs_review" };
  }
}

/** Numbers as written, e.g. "3", "-2.5", "10". Used to see whether numbers changed. */
export function numbersIn(text: string): string[] {
  return text.match(/-?\d+(?:\.\d+)?/g) ?? [];
}

const sortedKey = (values: string[]) => [...values].sort().join("\u0000");

export function sameNumbers(a: string, b: string): boolean {
  return sortedKey(numbersIn(a)) === sortedKey(numbersIn(b));
}

export function hasNumbers(content: Pick<QuestionContent, "prompt" | "codeSnippet">): boolean {
  return numbersIn(`${content.prompt}\n${content.codeSnippet ?? ""}`).length > 0;
}

const norm = (text: string | null | undefined) => (text ?? "").trim().replace(/\s+/g, " ");

/** The parts of a question that make up its answer, for comparing before and after. */
function answerPart(content: QuestionContent): unknown {
  switch (content.type) {
    case "mcq_single":
    case "mcq_multi":
      return { correct: [...content.correctOptionIds].sort() };
    case "fill_blank":
      return { blanks: content.blanks, caseSensitive: content.caseSensitive };
    default:
      return { accepted: content.accepted, caseSensitive: content.caseSensitive };
  }
}

const optionIds = (content: QuestionContent) =>
  content.type === "mcq_single" || content.type === "mcq_multi"
    ? content.options.map((o) => o.id)
    : [];

const optionTexts = (content: QuestionContent) =>
  content.type === "mcq_single" || content.type === "mcq_multi"
    ? content.options.map((o) => norm(o.text))
    : [];

/**
 * Checks a proposal against the question it was made from. Returns a short reason when it breaks
 * the rules of its mode, or null when it is acceptable. Used when the model answers and again when
 * a proposal is saved, so a client cannot label a changed answer as a "rephrase".
 */
export function checkProposal(
  mode: RewriteMode,
  original: QuestionContent,
  proposed: QuestionContent,
): string | null {
  if (proposed.type !== original.type) return "the question type changed";

  if (mode === "add_explanation") {
    if (norm(proposed.explanation).length === 0) return "no explanation was written";
    if (norm(proposed.explanation) === norm(original.explanation))
      return "the explanation did not change";
    if (
      norm(proposed.prompt) !== norm(original.prompt) ||
      norm(proposed.codeSnippet) !== norm(original.codeSnippet) ||
      JSON.stringify(optionTexts(proposed)) !== JSON.stringify(optionTexts(original)) ||
      JSON.stringify(optionIds(proposed)) !== JSON.stringify(optionIds(original)) ||
      JSON.stringify(answerPart(proposed)) !== JSON.stringify(answerPart(original))
    ) {
      return "only the explanation may change";
    }
    return null;
  }

  if (mode === "rephrase") {
    if (JSON.stringify(optionIds(proposed)) !== JSON.stringify(optionIds(original))) {
      return "the options were added, removed or reordered";
    }
    if (JSON.stringify(answerPart(proposed)) !== JSON.stringify(answerPart(original))) {
      return "the answer changed";
    }
    if (norm(proposed.codeSnippet) !== norm(original.codeSnippet)) return "the code changed";
    if (!sameNumbers(proposed.prompt, original.prompt)) return "the numbers changed";
    const changed =
      norm(proposed.prompt) !== norm(original.prompt) ||
      JSON.stringify(optionTexts(proposed)) !== JSON.stringify(optionTexts(original));
    if (!changed) return "nothing was rephrased";
    return null;
  }

  // vary_numbers: a new question with its own answer. It must differ in its numbers, and the
  // old answer must not simply have been copied across.
  const before = `${original.prompt}\n${original.codeSnippet ?? ""}`;
  const after = `${proposed.prompt}\n${proposed.codeSnippet ?? ""}`;
  if (numbersIn(before).length === 0) return "the question has no numbers to vary";
  if (sameNumbers(before, after)) return "the numbers did not change";
  if (
    JSON.stringify(answerPart(proposed)) === JSON.stringify(answerPart(original)) &&
    JSON.stringify(optionTexts(proposed)) === JSON.stringify(optionTexts(original))
  ) {
    return "the answer was copied from the original question";
  }
  return null;
}

/** What to tell the owner to check before accepting. */
export function warningsFor(mode: RewriteMode): string[] {
  switch (mode) {
    case "rephrase":
      return ["Check that the new wording still means the same thing."];
    case "add_explanation":
      return ["Check that the explanation is correct."];
    case "vary_numbers":
      return [
        "The answer for the new numbers was worked out by the assistant and has not been checked. Work it out yourself before accepting.",
      ];
  }
}

export const rewriteRequestSchema = z.object({
  mode: rewriteModeSchema,
  /** Optional guidance for the assistant, e.g. "make it harder". */
  hint: z.string().trim().min(1).max(300).optional(),
});

export type RewriteRequest = z.infer<typeof rewriteRequestSchema>;
