import { z } from "zod";

/**
 * Tunable review-scheduler parameters, stored per policy version. These are product
 * parameters, not scientific claims: change them by adding a new version, never by editing a
 * version that review states already point at. Unknown keys are errors so typos cannot hide.
 */
export const schedulerPolicyConfigSchema = z
  .object({
    /** Wrong answers retried within the same session (matches the requeue reveal mode). */
    inSessionRetry: z.object({ maxRetries: z.number().int().min(0).max(3) }).strict(),
    /** Days until the next review after each independent success, shortest first. */
    intervalsDays: z
      .array(z.number().int().positive().max(3650))
      .min(1)
      .max(12)
      .refine((days) => days.every((d, i) => i === 0 || d > days[i - 1]!), {
        message: "intervals must increase",
      }),
    /** Whether a correct answer that used help moves the schedule forward. */
    assistedAdvances: z.boolean(),
    /** After a lapse (a miss on review), how many interval steps to go back. */
    onLapse: z.object({ stepBack: z.number().int().min(0).max(12) }).strict(),
    /**
     * The most reviews offered on one local day. Anything beyond it is deferred to later days,
     * not marked as failed. Versions stored before this existed read as 20.
     */
    maxReviewsPerDay: z.number().int().min(1).max(500).default(20),
  })
  .strict()
  .refine((c) => c.onLapse.stepBack <= c.intervalsDays.length, {
    message: "stepBack cannot exceed the number of intervals",
    path: ["onLapse", "stepBack"],
  });
export type SchedulerPolicyConfig = z.infer<typeof schedulerPolicyConfigSchema>;

export const REVIEW_STATES = ["new", "learning", "reviewing", "suspended"] as const;
export const reviewStateSchema = z.enum(REVIEW_STATES);
export type ReviewState = z.infer<typeof reviewStateSchema>;

/** The policy new sessions and review states start with. */
export const DEFAULT_POLICY_VERSION = "v1";
