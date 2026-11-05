import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth";

/** One row per user per hour: how many AI calls they started in that window. */
export const aiUsage = pgTable(
  "ai_usage",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.windowStart] }),
    index("ai_usage_window_start_idx").on(t.windowStart),
  ],
);

/**
 * Request counters for the minute and UTC-day caps. `subject` is a user id, or `global` for the
 * app-wide daily cap. The hourly cap stays in `ai_usage`.
 */
export const aiRateWindows = pgTable(
  "ai_rate_windows",
  {
    subject: text("subject").notNull(),
    period: text("period", { enum: ["minute", "day"] }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.subject, t.period, t.windowStart] }),
    index("ai_rate_windows_window_start_idx").on(t.windowStart),
    check("ai_rate_windows_count_nonneg", sql`${t.count} >= 0`),
  ],
);

/** One row per AI operation that is running now. Expires on its own if a worker dies. */
export const aiCallLeases = pgTable(
  "ai_call_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    route: text("route").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("ai_call_leases_expires_at_idx").on(t.expiresAt)],
);

/**
 * One row per provider invocation. No prompt, reply or error text is stored. Token counts are null
 * when the provider did not report them.
 */
export const aiCallLogs = pgTable(
  "ai_call_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    route: text("route").notNull(),
    model: text("model"),
    method: text("method", {
      enum: ["generateText", "generateStructured", "streamText"],
    }).notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    outcome: text("outcome", {
      enum: [
        "started",
        "success",
        "quota",
        "timeout",
        "invalid_output",
        "unavailable",
        "cancelled",
      ],
    })
      .notNull()
      .default("started"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("ai_call_logs_user_started_idx").on(t.userId, t.startedAt),
    index("ai_call_logs_started_idx").on(t.startedAt),
  ],
);

/** A single row (`id = 1`): whether AI is paused after repeated provider quota errors. */
export const aiProviderState = pgTable(
  "ai_provider_state",
  {
    id: smallint("id").primaryKey().default(1),
    quotaErrorStreak: integer("quota_error_streak").notNull().default(0),
    lastQuotaErrorAt: timestamp("last_quota_error_at", { withTimezone: true }),
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    /** The one trial operation allowed after a cooldown, until it finishes. */
    probeLeaseId: uuid("probe_lease_id"),
  },
  (t) => [check("ai_provider_state_singleton", sql`${t.id} = 1`)],
);
