import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { questionRevisions } from "./questions";

/**
 * An uploaded image. The bytes live in private storage under `storage_key` and never change, so
 * one image can be linked from many revisions of a question.
 */
export const questionImages = pgTable(
  "question_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    storageKey: text("storage_key").notNull(),
    // Detected from the file's bytes at upload, and the only content type ever served.
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("question_images_storage_key_uq").on(t.storageKey),
    index("question_images_owner_id_idx").on(t.ownerId),
  ],
);

/**
 * Which image a revision shows, and its alt text. One image per revision. Rows are only ever
 * inserted: editing a question writes a new revision with a new row, and a trigger stops a row
 * from changing once an attempt references its revision.
 */
export const questionRevisionImages = pgTable(
  "question_revision_images",
  {
    questionRevisionId: uuid("question_revision_id")
      .primaryKey()
      .references(() => questionRevisions.id, { onDelete: "cascade" }),
    imageId: uuid("image_id")
      .notNull()
      .references(() => questionImages.id, { onDelete: "restrict" }),
    altText: text("alt_text").notNull(),
  },
  (t) => [
    index("question_revision_images_image_id_idx").on(t.imageId),
    check("question_revision_images_alt_length", sql`char_length(${t.altText}) between 1 and 300`),
  ],
);
