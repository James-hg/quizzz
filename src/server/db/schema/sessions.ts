import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { QuestionResponse } from "@/lib/schemas";
import { courses } from "./courses";
import { activityRole, gradingOutcome, sessionMode, sessionState } from "./enums";
import { questionRevisions, questionSets, questions } from "./questions";

export const studySessions = pgTable(
  "study_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "restrict" }),
    questionSetId: uuid("question_set_id").references(() => questionSets.id, {
      onDelete: "restrict",
    }),
    mode: sessionMode("mode").notNull(),
    state: sessionState("state").notNull().default("active"),
    timeBudgetMinutes: integer("time_budget_minutes"),
    elapsedSeconds: integer("elapsed_seconds").notNull().default(0),
    activeStartedAt: timestamp("active_started_at", { withTimezone: true }),
    currentIndex: integer("current_index").notNull().default(0),
    itemOrder: jsonb("item_order").$type<string[]>().notNull().default([]),
    policyVersion: text("policy_version").notNull().default("v1"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("study_sessions_user_id_idx").on(t.userId),
    index("study_sessions_course_id_idx").on(t.courseId),
  ],
);

export const attempts = pgTable(
  "attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => studySessions.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "restrict" }),
    questionRevisionId: uuid("question_revision_id")
      .notNull()
      .references(() => questionRevisions.id, { onDelete: "restrict" }),
    response: jsonb("response").$type<QuestionResponse>().notNull(),
    isCorrect: boolean("is_correct"),
    gradingOutcome: gradingOutcome("grading_outcome").notNull(),
    activityRole: activityRole("activity_role").notNull().default("scored"),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("attempts_user_idempotency_uq").on(t.userId, t.idempotencyKey),
    index("attempts_session_id_idx").on(t.sessionId),
    index("attempts_question_id_idx").on(t.questionId),
    index("attempts_question_revision_id_idx").on(t.questionRevisionId),
  ],
);
