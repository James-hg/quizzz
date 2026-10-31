import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { courses } from "./courses";
import { assistanceLevel, evidenceStatus, helpAction, hintOrigin, reviewState } from "./enums";
import { questionRevisions, questions } from "./questions";
import { schedulerPolicies } from "./scheduler";
import { attempts, studySessions } from "./sessions";

const HINT_LEVELS_SQL = sql`('conceptual_hint', 'next_step_hint', 'partial_example', 'full_explanation')`;
const tz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Minimal concept record so concept evidence has something to point at. C8 (#36) adds the
 * description, method tags, and confusable links.
 */
export const concepts = pgTable(
  "concepts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("concepts_course_name_uq").on(t.courseId, t.name),
    index("concepts_owner_id_idx").on(t.ownerId),
  ],
);

/** Reusable hint text for a question revision: the fallback when the AI is unavailable. */
export const approvedHints = pgTable(
  "approved_hints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Hints are content, not history: they go with their revision when it is deleted.
    questionRevisionId: uuid("question_revision_id")
      .notNull()
      .references(() => questionRevisions.id, { onDelete: "cascade" }),
    level: assistanceLevel("level").notNull(),
    text: text("text").notNull(),
    // Source segments the hint is based on. An array, so the database does not enforce them.
    sourceSegmentIds: uuid("source_segment_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    origin: hintOrigin("origin").notNull(),
    evidenceStatus: evidenceStatus("evidence_status").notNull().default("unresolved"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("approved_hints_revision_level_uq").on(t.questionRevisionId, t.level),
    check("approved_hints_level_chk", sql`${t.level} in ${HINT_LEVELS_SQL}`),
  ],
);

/**
 * One request for help, recorded before the student answers, so it belongs to a turn
 * (session, question, pass) rather than to an attempt that does not exist yet. A question can
 * have two turns in one session (first try and retry). When the answer is submitted the
 * attempt id is filled in once; nothing else about an event changes.
 */
export const helpEvents = pgTable(
  "help_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => studySessions.id, { onDelete: "restrict" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "restrict" }),
    questionRevisionId: uuid("question_revision_id")
      .notNull()
      .references(() => questionRevisions.id, { onDelete: "restrict" }),
    /** 1 for the first try, 2 for the single retry. Matches attempts.pass. */
    pass: smallint("pass").notNull().default(1),
    action: helpAction("action").notNull(),
    level: assistanceLevel("level").notNull(),
    /** The reusable hint shown, if one was used. */
    approvedHintId: uuid("approved_hint_id").references(() => approvedHints.id, {
      onDelete: "restrict",
    }),
    /** Generated text exactly as shown to the student, kept as evidence of what they saw. */
    contentText: text("content_text"),
    sourceSegmentIds: uuid("source_segment_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    provider: text("provider"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    latencyMs: integer("latency_ms"),
    /** Set once, when the answer this help preceded is submitted. */
    attemptId: uuid("attempt_id").references(() => attempts.id, { onDelete: "restrict" }),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("help_events_turn_idx").on(t.sessionId, t.questionId, t.pass),
    index("help_events_user_id_idx").on(t.userId),
    index("help_events_attempt_id_idx").on(t.attemptId),
    check("help_events_pass_chk", sql`${t.pass} in (1, 2)`),
    check("help_events_level_chk", sql`${t.level} in ${HINT_LEVELS_SQL}`),
    check(
      "help_events_content_chk",
      sql`${t.approvedHintId} is not null or ${t.contentText} is not null`,
    ),
  ],
);

/** Where a student stands with one question in the review schedule. */
export const reviewStates = pgTable(
  "review_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "restrict" }),
    state: reviewState("state").notNull().default("new"),
    stepIndex: integer("step_index").notNull().default(0),
    nextDueAt: tz("next_due_at"),
    lastIndependentSuccessAt: tz("last_independent_success_at"),
    delayedSuccessCount: integer("delayed_success_count").notNull().default(0),
    distinctSuccessDays: integer("distinct_success_days").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    policyVersion: text("policy_version")
      .notNull()
      .default("v1")
      .references(() => schedulerPolicies.version, { onDelete: "restrict" }),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("review_states_user_question_uq").on(t.userId, t.questionId),
    index("review_states_due_idx").on(t.userId, t.nextDueAt),
    check(
      "review_states_counts_chk",
      sql`${t.stepIndex} >= 0 and ${t.delayedSuccessCount} >= 0 and ${t.distinctSuccessDays} >= 0 and ${t.lapses} >= 0`,
    ),
  ],
);

/** Independent and assisted outcomes per concept: different evidence, kept apart. */
export const conceptEvidence = pgTable(
  "concept_evidence",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "restrict" }),
    independentCorrect: integer("independent_correct").notNull().default(0),
    assistedCorrect: integer("assisted_correct").notNull().default(0),
    newProblemChecks: integer("new_problem_checks").notNull().default(0),
    lastAt: tz("last_at"),
  },
  (t) => [
    unique("concept_evidence_user_concept_uq").on(t.userId, t.conceptId),
    check(
      "concept_evidence_counts_chk",
      sql`${t.independentCorrect} >= 0 and ${t.assistedCorrect} >= 0 and ${t.newProblemChecks} >= 0`,
    ),
  ],
);
