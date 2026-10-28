import "server-only";
import { and, eq, max } from "drizzle-orm";
import {
  contentToRevision,
  questionContentSchema,
  type DraftItemPayload,
  type PublishImportInput,
} from "@/lib/schemas";
import { assertOwnsQuestionSet } from "@/server/auth/ownership";
import type { Database } from "@/server/db";
import { addRevision } from "@/server/db/repositories/questions";
import {
  importDraftItems,
  importDrafts,
  questionSets,
  questionSourceLinks,
  questions,
  sourceSegments,
} from "@/server/db/schema";
import { badRequest, conflict, notFound } from "@/server/http/errors";
import { getOwnedImage } from "@/server/images/service";

type DraftQuestion = Extract<DraftItemPayload, { kind: "question" }>;

export type PublishResult = {
  questionSetId: string;
  published: number;
  unresolved: number;
  alreadyPublished: boolean;
};

function revisionFor(payload: DraftQuestion) {
  if (payload.correctOptionIds.length === 0) {
    // The answer could not be determined: keep the original wording, never guess.
    return {
      type: payload.type,
      prompt: payload.prompt,
      codeSnippet: payload.codeSnippet ?? null,
      explanation: payload.explanation ?? null,
      options: payload.options,
      answerKey: { kind: "unresolved" as const },
      evidenceStatus: "unresolved" as const,
    };
  }
  const content = questionContentSchema.parse(payload);
  return { ...contentToRevision(content), evidenceStatus: "human_reviewed" as const };
}

/**
 * Publishes accepted and edited items into a question set. The draft row is locked, so a
 * retry or double click returns the first result instead of creating a second set.
 */
export async function publishImport(
  db: Database,
  userId: string,
  draftId: string,
  input: PublishImportInput,
): Promise<PublishResult> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;

    const [draft] = await database
      .select()
      .from(importDrafts)
      .where(and(eq(importDrafts.id, draftId), eq(importDrafts.ownerId, userId)))
      .for("update");
    if (!draft) throw notFound("Import not found");

    if (draft.status === "published") {
      if (!draft.publishedQuestionSetId) {
        throw conflict("This import was published and its question set was deleted", "set_deleted");
      }
      return {
        questionSetId: draft.publishedQuestionSetId,
        published: 0,
        unresolved: 0,
        alreadyPublished: true,
      };
    }
    if (draft.status === "failed")
      throw conflict("This import failed and cannot be published", "failed");

    const items = await database
      .select()
      .from(importDraftItems)
      .where(eq(importDraftItems.draftId, draftId))
      .orderBy(importDraftItems.position);
    const chosen = items.filter(
      (item) =>
        (item.decision === "accepted" || item.decision === "edited") &&
        item.payload.kind === "question",
    );
    if (chosen.length === 0)
      throw badRequest("Accept at least one question to publish", "nothing_to_publish");

    let questionSetId: string;
    if (input.questionSetId) {
      const existing = await assertOwnsQuestionSet(database, userId, input.questionSetId);
      if (existing.courseId !== draft.courseId) {
        throw badRequest("That question set belongs to a different course");
      }
      questionSetId = existing.id;
    } else {
      const [created] = await database
        .insert(questionSets)
        .values({
          courseId: draft.courseId,
          ownerId: userId,
          title: input.title!,
          origin: "imported",
          sourceDocumentId: draft.sourceDocumentId,
        })
        .returning({ id: questionSets.id });
      questionSetId = created!.id;
    }

    const segments = await database
      .select({ id: sourceSegments.id, ordinal: sourceSegments.ordinal })
      .from(sourceSegments)
      .where(eq(sourceSegments.sourceDocumentId, draft.sourceDocumentId));
    const segmentByOrdinal = new Map(segments.map((s) => [s.ordinal, s.id]));

    const [last] = await database
      .select({ p: max(questions.position) })
      .from(questions)
      .where(eq(questions.questionSetId, questionSetId));
    let position = (last?.p ?? -1) + 1;
    let unresolved = 0;

    for (const item of chosen) {
      const payload = item.payload as DraftQuestion;
      const revision = revisionFor(payload);
      const isUnresolved = revision.answerKey.kind === "unresolved";
      if (isUnresolved) unresolved += 1;

      const [question] = await database
        .insert(questions)
        .values({
          questionSetId,
          position: position++,
          // Unresolved questions cannot be played or scheduled until an answer is set.
          status: isUnresolved ? "excluded" : "active",
        })
        .returning();
      const image = payload.image;
      if (image) {
        await getOwnedImage(database, userId, image.imageId);
        if (!image.alt.trim()) {
          throw badRequest(
            "Describe the image before publishing this question.",
            "image_alt_required",
          );
        }
      }
      const created = await addRevision(
        database,
        question!.id,
        { ...revision, origin: "original", createdBy: userId },
        { image: image ? { imageId: image.imageId, alt: image.alt.trim() } : undefined },
      );

      const links = item.sourceRefs.flatMap((ref) => {
        const segmentId = segmentByOrdinal.get(ref.ordinal);
        return segmentId
          ? [
              {
                questionRevisionId: created.id,
                sourceSegmentId: segmentId,
                relationship: "origin" as const,
              },
            ]
          : [];
      });
      if (links.length > 0) await database.insert(questionSourceLinks).values(links);
    }

    await database
      .update(importDrafts)
      .set({ status: "published", publishedQuestionSetId: questionSetId, updatedAt: new Date() })
      .where(eq(importDrafts.id, draftId));

    return { questionSetId, published: chosen.length, unresolved, alreadyPublished: false };
  });
}
