import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  draftQuestionPayloadSchema,
  type ExtractAnchor,
  type ExtractResult,
  type ImportWarning,
  type SourceRefs,
} from "@/lib/schemas";
import { stripQuestionNumber } from "@/lib/question-number";
import { getEnv } from "@/server/env";
import { deleteUnlinkedImages } from "@/server/images/service";
import { storeExtractedImages } from "./images";
import { assertOwnsCourse } from "@/server/auth/ownership";
import type { Database } from "@/server/db";
import {
  importDraftItems,
  importDrafts,
  sourceDocuments,
  sourceSegments,
} from "@/server/db/schema";
import { ExtractError } from "@/server/extract/errors";
import { validateUpload } from "@/server/extract/limits";
import { findExtractor, runExtraction, supportedFormats } from "@/server/extract/registry";
import type { ExtractLimits } from "@/server/extract/types";
import { ApiError, notFound } from "@/server/http/errors";
import type { StorageAdapter } from "@/server/storage/types";
import { detectorFor } from "./detectors";
import { ensureImportersRegistered } from "./setup";
import { insertSegments, setExtractionStatus, sha256 } from "./sources";
import type { DetectedQuestion } from "./types";
import type { ReceivedUpload } from "./upload";

type NewItem = typeof importDraftItems.$inferInsert;

const OPTION_IDS = "abcdefghij";

function unsupported(reason?: string) {
  const formats = supportedFormats();
  const list = formats.length ? formats.map((f) => f.label).join(", ") : "none available yet";
  return new ApiError(
    415,
    "unsupported_format",
    `${reason ?? "This file type is not supported."} Supported formats: ${list}.`,
    { supportedFormats: formats },
  );
}

function blockOrdinals(result: ExtractResult, question: DetectedQuestion): SourceRefs {
  const ids = question.blockIds ?? [];
  const byId = ids
    .map((id) => result.blocks.findIndex((block) => block.id === id))
    .filter((index) => index >= 0);
  if (byId.length > 0)
    return [...new Set(byId)].sort((a, b) => a - b).map((ordinal) => ({ ordinal }));
  const anchor = JSON.stringify(question.anchor);
  const fallback = result.blocks.findIndex((block) => JSON.stringify(block.anchor) === anchor);
  return fallback >= 0 ? [{ ordinal: fallback }] : [];
}

/** Turns detector output into draft items. Answers are never guessed: no mark -> unresolved. */
export function buildDraftItems(result: ExtractResult, detected: DetectedQuestion[]) {
  const items: Omit<NewItem, "draftId">[] = [];
  const warnings: ImportWarning[] = [];

  for (const question of detected) {
    const options = question.options.slice(0, OPTION_IDS.length).map((option, index) => ({
      id: OPTION_IDS[index]!,
      text: option.text,
    }));
    const correctOptionIds = question.options
      .slice(0, options.length)
      .flatMap((option, index) => (option.isCorrect ? [OPTION_IDS[index]!] : []));

    // A number the detector already removed is remembered; one that is still in the text (for
    // example typed into a Word list item) is removed here. Either way the original is kept so
    // the review page can restore it.
    let prompt = question.prompt;
    let originalPrompt = question.originalPrompt;
    if (!originalPrompt) {
      const stripped = stripQuestionNumber(prompt);
      if (stripped.removed) {
        originalPrompt = prompt;
        prompt = stripped.text;
      }
    }

    const payload = {
      kind: "question" as const,
      type: correctOptionIds.length > 1 ? ("mcq_multi" as const) : ("mcq_single" as const),
      prompt,
      ...(originalPrompt ? { originalPrompt } : {}),
      ...(question.image ? { image: question.image } : {}),
      options,
      correctOptionIds,
    };
    const parsed = draftQuestionPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      warnings.push({
        code: "question_skipped",
        message: `A detected question was skipped: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        anchor: question.anchor,
      });
      continue;
    }

    const itemWarnings: ImportWarning[] = question.warnings.map((w) => ({
      code: w.code,
      message: w.message,
      anchor: w.anchor ?? question.anchor,
    }));
    if (question.image && !question.image.alt.trim()) {
      itemWarnings.push({
        code: "image_alt_missing",
        message: "This question has an image. Describe it before accepting the question.",
        anchor: question.anchor,
      });
    }
    if (correctOptionIds.length === 0) {
      itemWarnings.push({
        code: "answer_unresolved",
        message: "No correct answer was marked. Choose the answer before this can be practised.",
        anchor: question.anchor,
      });
    }
    items.push({
      position: items.length,
      kind: "question",
      payload: parsed.data,
      itemWarnings,
      decision: "pending",
      sourceRefs: blockOrdinals(result, question),
    });
  }
  return { items, warnings };
}

export async function createImport(
  db: Database,
  storage: StorageAdapter,
  userId: string,
  courseId: string,
  upload: ReceivedUpload,
  limits: ExtractLimits,
) {
  await assertOwnsCourse(db, userId, courseId);
  ensureImportersRegistered();

  const file = { filename: upload.filename, mimeType: upload.mimeType };
  let validated;
  try {
    validated = await validateUpload(upload.bytes, file, limits);
  } catch (error) {
    if (error instanceof ApiError && error.code === "unsupported_format") {
      throw unsupported(error.message);
    }
    throw error;
  }
  const extractor = findExtractor(validated);
  if (!extractor) throw unsupported();

  const storageKey = await storage.put(upload.bytes);
  let documentId: string;
  try {
    const [document] = await db
      .insert(sourceDocuments)
      .values({
        ownerId: userId,
        courseId,
        filename: upload.filename,
        mimeType: validated.detectedMime,
        sizeBytes: upload.bytes.length,
        storageKey,
        sha256: sha256(upload.bytes),
        extractionStatus: "pending",
      })
      .returning({ id: sourceDocuments.id });
    documentId = document!.id;
  } catch (error) {
    await storage.delete(storageKey);
    throw error;
  }

  let result: ExtractResult;
  try {
    result = await runExtraction(upload.bytes, file, limits);
  } catch (error) {
    // Keep the source document so the failure is visible and the file is not lost.
    const message = error instanceof ExtractError ? error.message : "This file could not be read.";
    await setExtractionStatus(db, documentId, "failed");
    const [failed] = await db
      .insert(importDrafts)
      .values({
        ownerId: userId,
        courseId,
        sourceDocumentId: documentId,
        status: "failed",
        errorMessage: message,
      })
      .returning({ id: importDrafts.id });
    // Tell the client where to read the failed import, keeping the original status and code.
    if (error instanceof ExtractError) {
      throw new ApiError(error.status, error.code, error.message, { importId: failed!.id });
    }
    throw new ApiError(422, "corrupt", message, { importId: failed!.id });
  }

  const detector = detectorFor(extractor.name);
  const detection = detector ? detector(result) : { questions: [], warnings: [] };
  // Images that could be read from the document are kept with their questions; the "image not
  // imported" warning only stays for the ones that could not be.
  const images = await storeExtractedImages(
    db,
    storage,
    userId,
    upload.bytes,
    limits,
    result,
    detection.questions,
    getEnv().MAX_IMAGE_BYTES,
  );
  const built = buildDraftItems(result, images.questions);
  const keepsWarning = (w: { code: string; anchor?: ExtractAnchor }) =>
    !(
      w.code === "image_dependency" &&
      w.anchor?.type === "docx_paragraph" &&
      images.keptParagraphs.has(w.anchor.index)
    );
  const warnings: ImportWarning[] = [
    ...result.warnings
      .filter(keepsWarning)
      .map((w) => ({ code: w.code, message: w.message, anchor: w.anchor })),
    ...detection.warnings.map((w) => ({ code: w.code, message: w.message, anchor: w.anchor })),
    ...built.warnings,
    ...images.warnings,
  ];
  if (!detector) {
    warnings.push({
      code: "no_question_detector",
      message: "Questions cannot be detected automatically in this format yet.",
    });
  } else if (built.items.length === 0) {
    warnings.push({
      code: "no_questions_found",
      message: "No multiple-choice questions were found.",
    });
  }

  let draftId: string;
  try {
    draftId = await db.transaction(async (tx) => {
      const database = tx as unknown as Database;
      await insertSegments(database, documentId, result.blocks);
      await setExtractionStatus(database, documentId, "extracted");
      const [draft] = await database
        .insert(importDrafts)
        .values({ ownerId: userId, courseId, sourceDocumentId: documentId, warnings })
        .returning({ id: importDrafts.id });
      if (built.items.length > 0) {
        await database
          .insert(importDraftItems)
          .values(built.items.map((item) => ({ ...item, draftId: draft!.id })));
      }
      return draft!.id;
    });
  } catch (error) {
    // Do not leave the images of an import that never saved.
    await deleteUnlinkedImages(db, storage, images.imageIds);
    throw error;
  }
  return getImport(db, userId, draftId);
}

/** Resolves a draft only if `userId` owns it; other users' drafts are indistinguishable from missing. */
export async function getOwnedDraft(db: Database, userId: string, draftId: string) {
  const [draft] = await db
    .select()
    .from(importDrafts)
    .where(and(eq(importDrafts.id, draftId), eq(importDrafts.ownerId, userId)));
  if (!draft) throw notFound("Import not found");
  return draft;
}

export async function getImport(db: Database, userId: string, draftId: string) {
  const draft = await getOwnedDraft(db, userId, draftId);
  const [document] = await db
    .select({
      id: sourceDocuments.id,
      filename: sourceDocuments.filename,
      mimeType: sourceDocuments.mimeType,
      sizeBytes: sourceDocuments.sizeBytes,
      extractionStatus: sourceDocuments.extractionStatus,
    })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, draft.sourceDocumentId));
  const items = await db
    .select()
    .from(importDraftItems)
    .where(eq(importDraftItems.draftId, draftId))
    .orderBy(asc(importDraftItems.position));

  const ordinals = [...new Set(items.flatMap((item) => item.sourceRefs.map((r) => r.ordinal)))];
  const segments = ordinals.length
    ? await db
        .select({
          ordinal: sourceSegments.ordinal,
          kind: sourceSegments.kind,
          text: sourceSegments.text,
          anchor: sourceSegments.anchor,
        })
        .from(sourceSegments)
        .where(
          and(
            eq(sourceSegments.sourceDocumentId, draft.sourceDocumentId),
            inArray(sourceSegments.ordinal, ordinals),
          ),
        )
    : [];
  const byOrdinal = new Map(segments.map((s) => [s.ordinal, s]));

  return {
    id: draft.id,
    courseId: draft.courseId,
    status: draft.status,
    errorMessage: draft.errorMessage,
    warnings: draft.warnings,
    publishedQuestionSetId: draft.publishedQuestionSetId,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    source: document ?? null,
    items: items.map((item) => ({
      id: item.id,
      position: item.position,
      kind: item.kind,
      payload: item.payload,
      warnings: item.itemWarnings,
      decision: item.decision,
      sources: item.sourceRefs.flatMap((ref) => byOrdinal.get(ref.ordinal) ?? []),
    })),
  };
}
