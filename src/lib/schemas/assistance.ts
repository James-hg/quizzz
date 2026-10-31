import { z } from "zod";

/**
 * How much help a student used before submitting an answer, weakest first. The order is the
 * strength order, and it matches the Postgres enum, so `max(level)` is the strongest used.
 * A correct answer with a hint is still correct, but it is different evidence.
 */
export const ASSISTANCE_LEVELS = [
  "none",
  "conceptual_hint",
  "next_step_hint",
  "partial_example",
  "full_explanation",
  "solution_revealed",
] as const;
export const assistanceLevelSchema = z.enum(ASSISTANCE_LEVELS);
export type AssistanceLevel = z.infer<typeof assistanceLevelSchema>;

/** Levels a stored, reusable hint can have: help that is text, not "no help" or the answer key. */
export const HINT_LEVELS = [
  "conceptual_hint",
  "next_step_hint",
  "partial_example",
  "full_explanation",
] as const;
export const hintLevelSchema = z.enum(HINT_LEVELS);

export const HELP_ACTIONS = [
  "small_hint",
  "explain_step",
  "why_wrong",
  "similar_example",
  "full_explanation",
] as const;
export const helpActionSchema = z.enum(HELP_ACTIONS);
export type HelpAction = z.infer<typeof helpActionSchema>;

export const hintOriginSchema = z.enum(["owner", "ai_proposed", "sample"]);

export const assistanceRank = (level: AssistanceLevel) => ASSISTANCE_LEVELS.indexOf(level);

/** The strongest level in a list: what an attempt records as its assistance. */
export function strongestAssistance(levels: readonly AssistanceLevel[]): AssistanceLevel {
  return levels.reduce<AssistanceLevel>(
    (best, level) => (assistanceRank(level) > assistanceRank(best) ? level : best),
    "none",
  );
}

/** True when the answer was given without any help. */
export const isUnaided = (level: AssistanceLevel) => level === "none";

const segmentIds = z.array(z.uuid()).max(50).default([]);

/** One help request, recorded before the student answers. Generated text is kept as shown. */
export const helpEventInputSchema = z
  .object({
    sessionId: z.uuid(),
    questionId: z.uuid(),
    /** The turn being helped: 1, or 2 for the retry of a wrong answer. */
    pass: z.union([z.literal(1), z.literal(2)]),
    action: helpActionSchema,
    level: z.enum(HINT_LEVELS),
    approvedHintId: z.uuid().optional(),
    contentText: z.string().min(1).max(8000).optional(),
    sourceSegmentIds: segmentIds,
    provider: z.string().max(60).optional(),
    model: z.string().max(120).optional(),
    promptVersion: z.string().max(60).optional(),
    latencyMs: z.number().int().nonnegative().optional(),
  })
  .refine((v) => v.approvedHintId !== undefined || v.contentText !== undefined, {
    message: "a help event needs an approved hint or the text that was shown",
    path: ["contentText"],
  });
export type HelpEventInput = z.infer<typeof helpEventInputSchema>;
