import { index, integer, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
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
