import "server-only";
import type { ExtractResult, ImportWarning } from "@/lib/schemas";
import type { Database } from "@/server/db";
import { ApiError } from "@/server/http/errors";
import type { ExtractLimits } from "@/server/extract/types";
import { readZipEntries } from "@/server/extract/zip";
import { IMAGE_ALT_MAX } from "@/lib/images";
import { createImage } from "@/server/images/service";
import type { StorageAdapter } from "@/server/storage/types";
import type { DetectedQuestion } from "./types";

export type StoredImages = {
  questions: DetectedQuestion[];
  /** Every image saved for this import, so they can be removed if the import is abandoned. */
  imageIds: string[];
  /** Paragraph indexes whose image was kept, so their "image not imported" warning can go. */
  keptParagraphs: Set<number>;
  warnings: ImportWarning[];
};

/**
 * Reads each question's image out of the uploaded document, checks it exactly like an upload,
 * and stores it privately. An image that cannot be kept (wrong type, too big, unreadable) is
 * skipped, and its "image not imported" warning stays. Alt text comes from the document's own
 * description and may be empty; the owner must fill it in before accepting the question.
 */
export async function storeExtractedImages(
  db: Database,
  storage: StorageAdapter,
  userId: string,
  documentBytes: Buffer,
  limits: ExtractLimits,
  result: ExtractResult,
  questions: DetectedQuestion[],
  maxImageBytes: number,
): Promise<StoredImages> {
  const wanted = questions.flatMap((q) => {
    const asset = q.imageAssetId ? result.assets.find((a) => a.id === q.imageAssetId) : undefined;
    return asset?.entryName && asset.sizeBytes <= maxImageBytes ? [asset] : [];
  });
  const stored: StoredImages = {
    questions,
    imageIds: [],
    keptParagraphs: new Set(),
    warnings: [],
  };
  if (wanted.length === 0) return stored;

  const entries = readZipEntries(documentBytes, limits, (name) =>
    wanted.some((asset) => asset.entryName === name),
  );
  const byAsset = new Map<string, { imageId: string; alt: string }>();
  // The same picture can appear in several questions; it is stored once and shared.
  const byEntry = new Map<string, string | null>();

  for (const asset of wanted) {
    if (byAsset.has(asset.id)) continue;
    const entryName = asset.entryName!;
    if (!byEntry.has(entryName)) {
      const bytes = entries.get(entryName);
      let imageId: string | null = null;
      if (bytes) {
        try {
          imageId = (await createImage(db, storage, userId, bytes, maxImageBytes)).id;
          stored.imageIds.push(imageId);
        } catch (error) {
          // A bad image must not fail the whole import; the question keeps its warning instead.
          if (!(error instanceof ApiError)) throw error;
        }
      }
      byEntry.set(entryName, imageId);
    }
    const imageId = byEntry.get(entryName);
    if (imageId) byAsset.set(asset.id, { imageId, alt: clampAlt(asset.alt) });
  }

  stored.questions = questions.map((question) => {
    const kept = question.imageAssetId ? byAsset.get(question.imageAssetId) : undefined;
    if (!kept) return question;
    const asset = result.assets.find((a) => a.id === question.imageAssetId);
    const index = asset?.anchor?.type === "docx_paragraph" ? asset.anchor.index : undefined;
    if (index !== undefined) stored.keptParagraphs.add(index);
    return {
      ...question,
      image: kept,
      warnings: question.warnings.filter((w) => w.code !== "image_dependency"),
    };
  });
  for (const question of stored.questions) {
    if (question.extraImages) {
      stored.warnings.push({
        code: "extra_images_not_imported",
        message: `Only the first image of this question was imported; ${question.extraImages} more ${question.extraImages === 1 ? "was" : "were"} left out.`,
        anchor: question.anchor,
      });
    }
  }
  return stored;
}

/**
 * An author's description is kept when it fits. A longer one is cut to the limit (the owner can
 * edit it in review) so it can never make the whole question fail validation.
 */
export function clampAlt(alt: string | undefined): string {
  let text = (alt ?? "").trim();
  if (text.length > IMAGE_ALT_MAX) {
    text = text.slice(0, IMAGE_ALT_MAX);
    // Do not leave half of a surrogate pair at the cut.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    text = text.trim();
  }
  return text;
}
