import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { Anchor } from "@/lib/schemas";
import { courses } from "./courses";
import { segmentKind } from "./enums";

export const sourceDocuments = pgTable(
  "source_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").notNull(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    extractionStatus: text("extraction_status").notNull().default("pending"),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("source_documents_owner_id_idx").on(t.ownerId),
    index("source_documents_course_id_idx").on(t.courseId),
  ],
);

export const sourceSegments = pgTable(
  "source_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => sourceDocuments.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    kind: segmentKind("kind").notNull(),
    text: text("text").notNull(),
    anchor: jsonb("anchor").$type<Anchor>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("source_segments_doc_ordinal_uq").on(t.sourceDocumentId, t.ordinal)],
);
