import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnswerKey, Option } from "@/lib/schemas";
import { user } from "./auth";
import { courses } from "./courses";
import {
  evidenceStatus,
  linkRelationship,
  questionSetOrigin,
  questionStatus,
  questionType,
  revisionOrigin,
} from "./enums";
import { sourceDocuments, sourceSegments } from "./sources";

export const questionSets = pgTable(
  "question_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    origin: questionSetOrigin("origin").notNull(),
    sourceDocumentId: uuid("source_document_id").references(() => sourceDocuments.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("question_sets_course_id_idx").on(t.courseId),
    index("question_sets_owner_id_idx").on(t.ownerId),
  ],
);

export const questions = pgTable(
  "questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // RESTRICT: a question set holding attempted questions cannot be deleted away.
    questionSetId: uuid("question_set_id")
      .notNull()
      .references(() => questionSets.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    currentRevisionId: uuid("current_revision_id").references(
      (): AnyPgColumn => questionRevisions.id,
      { onDelete: "restrict" },
    ),
    status: questionStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("questions_question_set_id_idx").on(t.questionSetId)],
);

export const questionRevisions = pgTable(
  "question_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "restrict" }),
    revisionNumber: integer("revision_number").notNull(),
    type: questionType("type").notNull(),
    prompt: text("prompt").notNull(),
    codeSnippet: text("code_snippet"),
    options: jsonb("options").$type<Option[]>().notNull().default([]),
    answerKey: jsonb("answer_key").$type<AnswerKey>().notNull(),
    explanation: text("explanation"),
    origin: revisionOrigin("origin").notNull(),
    evidenceStatus: evidenceStatus("evidence_status").notNull().default("unresolved"),
    createdBy: uuid("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("question_revisions_question_number_uq").on(t.questionId, t.revisionNumber),
    index("question_revisions_question_id_idx").on(t.questionId),
  ],
);

export const questionSourceLinks = pgTable(
  "question_source_links",
  {
    questionRevisionId: uuid("question_revision_id")
      .notNull()
      .references(() => questionRevisions.id, { onDelete: "restrict" }),
    sourceSegmentId: uuid("source_segment_id")
      .notNull()
      .references(() => sourceSegments.id, { onDelete: "cascade" }),
    relationship: linkRelationship("relationship").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.questionRevisionId, t.sourceSegmentId, t.relationship] }),
    index("question_source_links_segment_idx").on(t.sourceSegmentId),
  ],
);
