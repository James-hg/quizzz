import { date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { courseLanguage } from "./enums";

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const courses = pgTable(
  "courses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    subject: text("subject").notNull(),
    language: courseLanguage("language"),
    examDate: date("exam_date"),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("courses_owner_id_idx").on(t.ownerId)],
);
