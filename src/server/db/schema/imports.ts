import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { DraftItemPayload, ImportWarning, SourceRefs } from "@/lib/schemas";
import { user } from "./auth";
import { courses } from "./courses";
import { questionSets } from "./questions";
import { sourceDocuments } from "./sources";

export const importStatus = pgEnum("import_status", [
  "extracted",
  "reviewing",
  "published",
  "failed",
]);
export const importItemKind = pgEnum("import_item_kind", ["question", "material"]);
export const importDecision = pgEnum("import_decision", [
  "pending",
  "accepted",
  "edited",
  "excluded",
]);

export const importDrafts = pgTable(
  "import_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => sourceDocuments.id, { onDelete: "cascade" }),
    status: importStatus("status").notNull().default("extracted"),
    warnings: jsonb("warnings").$type<ImportWarning[]>().notNull().default([]),
    errorMessage: text("error_message"),
    publishedQuestionSetId: uuid("published_question_set_id").references(() => questionSets.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("import_drafts_owner_id_idx").on(t.ownerId),
    index("import_drafts_course_id_idx").on(t.courseId),
  ],
);

export const importDraftItems = pgTable(
  "import_draft_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => importDrafts.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    kind: importItemKind("kind").notNull(),
    payload: jsonb("payload").$type<DraftItemPayload>().notNull(),
    itemWarnings: jsonb("item_warnings").$type<ImportWarning[]>().notNull().default([]),
    decision: importDecision("decision").notNull().default("pending"),
    sourceRefs: jsonb("source_refs").$type<SourceRefs>().notNull().default([]),
  },
  (t) => [unique("import_draft_items_position_uq").on(t.draftId, t.position)],
);
