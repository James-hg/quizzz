import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { questionRevisions } from "./questions";

/**
 * One named check of one revision. A run is every check made together (same `run_id`), so a
 * reader never mixes results from different validator versions. Rows are only ever added.
 * `not_applicable` means the check had nothing to look at; it is never a pass.
 */
export const contentChecks = pgTable(
  "content_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionRevisionId: uuid("question_revision_id")
      .notNull()
      .references(() => questionRevisions.id, { onDelete: "restrict" }),
    runId: uuid("run_id").notNull(),
    checkName: text("check_name").notNull(),
    result: text("result").notNull(),
    validatorVersion: text("validator_version").notNull(),
    /** Hash of everything the checks looked at, so an unchanged revision is not re-checked. */
    inputHash: text("input_hash").notNull(),
    /** Short reason codes and ids only: no document text and no model output. */
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("content_checks_revision_idx").on(t.questionRevisionId, t.createdAt),
    index("content_checks_run_idx").on(t.runId),
    check("content_checks_result_chk", sql`${t.result} in ('pass', 'fail', 'not_applicable')`),
  ],
);

/** The owner's decision about a revision. Kept apart from machine results on purpose. */
export const contentReviewDecisions = pgTable(
  "content_review_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The revision the decision produced (the approved or rejected one). */
    questionRevisionId: uuid("question_revision_id")
      .notNull()
      .references(() => questionRevisions.id, { onDelete: "restrict" }),
    /** The check run that was current when the owner decided. */
    checkRunId: uuid("check_run_id"),
    reviewerId: uuid("reviewer_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    /** Why the owner kept an answer that differs from the imported one. */
    conflictReason: text("conflict_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("content_review_decisions_revision_idx").on(t.questionRevisionId),
    check("content_review_decisions_decision_chk", sql`${t.decision} in ('approve', 'reject')`),
    check(
      "content_review_decisions_reason_chk",
      sql`${t.conflictReason} is null or char_length(${t.conflictReason}) <= 500`,
    ),
  ],
);
