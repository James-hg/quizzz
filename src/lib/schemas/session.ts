import { z } from "zod";
import { responseSchema } from "./response";

/** A practice session on one question set (the original quiz behavior). */
const quizSessionSchema = z.object({
  questionSetId: z.uuid(),
  mode: z.literal("quiz").default("quiz"),
  /** When the student sees results. Ignored when resuming a session that is already running. */
  revealMode: z.enum(["each", "end", "requeue"]).default("each"),
});

export const TIME_BUDGETS = [5, 10, 20] as const;

/**
 * A planned session over a whole course. The server picks the questions, and fixes the feedback
 * rules for the mode (review retries wrong answers once, exam shows results only at the end), so
 * a question set or a reveal mode here is an error rather than something to quietly ignore.
 */
const courseSessionSchema = z
  .object({
    courseId: z.uuid(),
    mode: z.enum(["review", "exam"]),
    timeBudgetMinutes: z.union([z.literal(5), z.literal(10), z.literal(20)]),
  })
  .strict();

export const createSessionSchema = z.union([courseSessionSchema, quizSessionSchema]);
export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type CourseSessionInput = z.infer<typeof courseSessionSchema>;

/** Client-chosen key that makes retries of one submission safe. */
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, "may only contain letters, digits, and _ . : -");

export const submitAnswerSchema = z.object({
  questionId: z.uuid(),
  response: responseSchema,
  idempotencyKey: idempotencyKeySchema,
  /**
   * Which turn this answers: 1 (default) or 2 for the retry of a wrong answer. Stated by the
   * client so a stale tab can never silently use up a retry; a mismatch is `already_answered`.
   */
  pass: z.union([z.literal(1), z.literal(2)]).default(1),
});

export const patchSessionSchema = z.object({ action: z.enum(["pause", "resume"]) });

export type SubmitAnswerInput = z.infer<typeof submitAnswerSchema>;
