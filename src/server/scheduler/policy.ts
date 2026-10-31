import type { SchedulerPolicyConfig } from "@/lib/schemas";

export type SchedulerPolicy = SchedulerPolicyConfig;

/**
 * Policy v1 as seeded by migration 0010. Its stored config has no daily cap, which reads as the
 * default of 20. Kept in code for tests; the database row for a version is the source of truth
 * at run time.
 */
export const POLICY_V1: SchedulerPolicy = {
  inSessionRetry: { maxRetries: 1 },
  intervalsDays: [1, 3, 7, 14],
  assistedAdvances: false,
  onLapse: { stepBack: 1 },
  maxReviewsPerDay: 20,
};
