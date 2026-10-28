import "server-only";
import { createHash } from "node:crypto";
import { and, eq, inArray, lt, notExists, sql } from "drizzle-orm";
import { imageUrl, type QuestionImageView } from "@/lib/images";
import type { Database } from "@/server/db";
import { importDraftItems, questionImages, questionRevisionImages } from "@/server/db/schema";
import { conflict, notFound } from "@/server/http/errors";
import type { StorageAdapter } from "@/server/storage/types";
import { detectImage } from "./validate";

type ImageRow = typeof questionImages.$inferSelect;

/** True for an image that no saved question shows. */
const notLinkedToQuestion = (db: Database) =>
  notExists(
    db
      .select({ one: questionRevisionImages.imageId })
      .from(questionRevisionImages)
      .where(eq(questionRevisionImages.imageId, questionImages.id)),
  );

/** True for an image that no import draft is still waiting to publish. */
const notNeededByDraft = (db: Database) =>
  notExists(
    db
      .select({ one: sql`1` })
      .from(importDraftItems)
      .where(sql`${importDraftItems.payload}->'image'->>'imageId' = ${questionImages.id}::text`),
  );

/** How many uploaded-but-unattached images one user may hold at a time. */
export const MAX_STAGED_IMAGES = 50;

/**
 * Validates the bytes and stores them privately. The image is staged: nothing shows it until a
 * question revision links to it.
 */
export async function createImage(
  db: Database,
  storage: StorageAdapter,
  userId: string,
  bytes: Uint8Array,
  maxBytes: number,
): Promise<ImageRow> {
  const { mime } = await detectImage(bytes, maxBytes);
  const storageKey = await storage.put(bytes);
  try {
    const [row] = await db
      .insert(questionImages)
      .values({
        ownerId: userId,
        storageKey,
        mimeType: mime,
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })
      .returning();
    return row!;
  } catch (error) {
    await storage.delete(storageKey);
    throw error;
  }
}

/** The image, only if `userId` owns it. Another user's image looks exactly like a missing one. */
export async function getOwnedImage(db: Database, userId: string, imageId: string) {
  const [row] = await db
    .select()
    .from(questionImages)
    .where(and(eq(questionImages.id, imageId), eq(questionImages.ownerId, userId)));
  if (!row) throw notFound("Image not found");
  return row;
}

/** What each revision shows, for views. Revisions without an image are absent from the map. */
export async function loadImagesForRevisions(
  db: Database,
  revisionIds: string[],
): Promise<Map<string, QuestionImageView>> {
  const result = new Map<string, QuestionImageView>();
  if (revisionIds.length === 0) return result;
  const rows = await db
    .select({
      revisionId: questionRevisionImages.questionRevisionId,
      imageId: questionRevisionImages.imageId,
      alt: questionRevisionImages.altText,
    })
    .from(questionRevisionImages)
    .where(inArray(questionRevisionImages.questionRevisionId, revisionIds));
  for (const row of rows) {
    result.set(row.revisionId, { id: row.imageId, url: imageUrl(row.imageId), alt: row.alt });
  }
  return result;
}

/**
 * Deletes the given images (row and stored bytes) when nothing links to them any more. Safe to
 * call with images that are still in use: those are left alone.
 */
export async function deleteUnlinkedImages(
  db: Database,
  storage: StorageAdapter,
  imageIds: string[],
): Promise<number> {
  if (imageIds.length === 0) return 0;
  const unlinked = await db
    .select({ id: questionImages.id, storageKey: questionImages.storageKey })
    .from(questionImages)
    .where(
      and(inArray(questionImages.id, imageIds), notLinkedToQuestion(db), notNeededByDraft(db)),
    );
  for (const image of unlinked) {
    await db.delete(questionImages).where(eq(questionImages.id, image.id));
    await storage.delete(image.storageKey);
  }
  return unlinked.length;
}

/**
 * Removes images that were uploaded but never attached to a saved question and are older than
 * `olderThanMs`. Not scheduled yet; call it from a cleanup job.
 */
export async function purgeOrphanImages(
  db: Database,
  storage: StorageAdapter,
  olderThanMs: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const stale = await db
    .select({ id: questionImages.id })
    .from(questionImages)
    .where(lt(questionImages.createdAt, cutoff));
  return deleteUnlinkedImages(
    db,
    storage,
    stale.map((s) => s.id),
  );
}

/** Ids of the images linked from these revisions (used before deleting them). */
export async function imageIdsOfRevisions(db: Database, revisionIds: string[]): Promise<string[]> {
  if (revisionIds.length === 0) return [];
  const rows = await db
    .select({ id: questionRevisionImages.imageId })
    .from(questionRevisionImages)
    .where(inArray(questionRevisionImages.questionRevisionId, revisionIds));
  return [...new Set(rows.map((r) => r.id))];
}

/**
 * Images the user uploaded that no saved question shows and no import draft is waiting on.
 * (An import's pictures belong to the draft and do not count against the upload limit.)
 */
export async function countStagedImages(db: Database, userId: string): Promise<number> {
  const rows = await db
    .select({ id: questionImages.id })
    .from(questionImages)
    .where(and(eq(questionImages.ownerId, userId), notLinkedToQuestion(db), notNeededByDraft(db)));
  return rows.length;
}

/** Deletes the user's staged images older than `olderThanMs`. Returns how many were removed. */
export async function releaseStagedImages(
  db: Database,
  storage: StorageAdapter,
  userId: string,
  olderThanMs: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const stale = await db
    .select({ id: questionImages.id })
    .from(questionImages)
    .where(and(eq(questionImages.ownerId, userId), lt(questionImages.createdAt, cutoff)));
  return deleteUnlinkedImages(
    db,
    storage,
    stale.map((s) => s.id),
  );
}

/** Staged images this old are assumed abandoned (an upload whose save never happened). */
export const STAGED_IMAGE_GRACE_MS = 60 * 60 * 1000;

/**
 * Makes room for one more upload. At the limit, the user's abandoned staged images are released
 * first; the upload is only refused if they are all recent.
 */
export async function ensureStagingRoom(
  db: Database,
  storage: StorageAdapter,
  userId: string,
): Promise<void> {
  if ((await countStagedImages(db, userId)) < MAX_STAGED_IMAGES) return;
  await releaseStagedImages(db, storage, userId, STAGED_IMAGE_GRACE_MS);
  if ((await countStagedImages(db, userId)) < MAX_STAGED_IMAGES) return;
  throw conflict(
    "You have too many images waiting to be attached. Save the questions they belong to, or wait an hour and try again.",
    "too_many_staged_images",
  );
}

/** Deletes one of the user's own images, but only while nothing is using it. */
export async function deleteOwnedImage(
  db: Database,
  storage: StorageAdapter,
  userId: string,
  imageId: string,
): Promise<void> {
  await getOwnedImage(db, userId, imageId);
  const removed = await deleteUnlinkedImages(db, storage, [imageId]);
  if (removed === 0) {
    throw conflict("This image is still used by a question or an import.", "image_in_use");
  }
}
