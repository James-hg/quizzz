import "server-only";
import { createHash } from "node:crypto";
import { and, eq, inArray, lt, notExists } from "drizzle-orm";
import { imageUrl, type QuestionImageView } from "@/lib/images";
import type { Database } from "@/server/db";
import { questionImages, questionRevisionImages } from "@/server/db/schema";
import { notFound } from "@/server/http/errors";
import type { StorageAdapter } from "@/server/storage/types";
import { detectImage } from "./validate";

type ImageRow = typeof questionImages.$inferSelect;

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
      and(
        inArray(questionImages.id, imageIds),
        notExists(
          db
            .select({ one: questionRevisionImages.imageId })
            .from(questionRevisionImages)
            .where(eq(questionRevisionImages.imageId, questionImages.id)),
        ),
      ),
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
