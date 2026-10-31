import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { SchedulerPolicyConfig } from "@/lib/schemas";

/**
 * Versioned review-scheduler parameters. A version is never edited once review states use it:
 * add a new version instead. Version "v1" is seeded by the migration that creates this table.
 */
export const schedulerPolicies = pgTable("scheduler_policies", {
  version: text("version").primaryKey(),
  config: jsonb("config").$type<SchedulerPolicyConfig>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
