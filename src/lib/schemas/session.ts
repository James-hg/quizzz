import { z } from "zod";
import { responseSchema } from "./response";

export const createSessionSchema = z.object({
  questionSetId: z.uuid(),
  mode: z.literal("quiz").default("quiz"),
  /** When the student sees results. Ignored when resuming a session that is already running. */
  revealMode: z.enum(["each", "end", "requeue"]).default("each"),
});

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
});

export const patchSessionSchema = z.object({ action: z.enum(["pause", "resume"]) });

export type SubmitAnswerInput = z.infer<typeof submitAnswerSchema>;
