import { index, jsonb, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import type { QuestionContent } from "@/lib/schemas";
import { user } from "./auth";
import { evidenceStatus, revisionOrigin } from "./enums";
import { questionRevisions, questions } from "./questions";

export const rewriteMode = pgEnum("rewrite_mode", ["rephrase", "vary_numbers", "add_explanation"]);
export const rewriteStatus = pgEnum("rewrite_status", ["pending", "accepted", "dismissed"]);

/**
 * An AI rewrite of an existing question, waiting for the owner. It is not a revision: the
 * question keeps its playable revision until the owner accepts, and the original and its
 * attempts are never touched by a proposal.
 */
export const questionRewrites = pgTable(
  "question_rewrites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    /** The revision the proposal was made from. Accepting in place needs it to still be current. */
    baseRevisionId: uuid("base_revision_id")
      .notNull()
      .references(() => questionRevisions.id, { onDelete: "cascade" }),
    mode: rewriteMode("mode").notNull(),
    content: jsonb("content").$type<QuestionContent>().notNull(),
    origin: revisionOrigin("origin").notNull(),
    evidenceStatus: evidenceStatus("evidence_status").notNull(),
    status: rewriteStatus("status").notNull().default("pending"),
    /** Set when accepted: the question and revision the proposal became. */
    resultQuestionId: uuid("result_question_id").references(() => questions.id, {
      onDelete: "set null",
    }),
    resultRevisionId: uuid("result_revision_id").references(() => questionRevisions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("question_rewrites_question_status_idx").on(t.questionId, t.status),
    index("question_rewrites_owner_id_idx").on(t.ownerId),
  ],
);
