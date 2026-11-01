import "server-only";
import { and, eq, max } from "drizzle-orm";
import type { QuestionImageInput } from "@/lib/images";
import { answerKeySchema, optionsSchema } from "@/lib/schemas";
import type { Database } from "../index";
import {
  questionRevisionImages,
  questionRevisions,
  questionSourceLinks,
  questions,
} from "../schema";

type RevisionInsert = typeof questionRevisions.$inferInsert;
type RevisionRow = typeof questionRevisions.$inferSelect;

export type NewRevision = Omit<RevisionInsert, "id" | "questionId" | "revisionNumber">;

/** Validates jsonb columns before they reach the database. */
export function parseRevisionJson<T extends Pick<RevisionRow, "options" | "answerKey">>(row: T): T {
  return {
    ...row,
    options: optionsSchema.parse(row.options),
    answerKey: answerKeySchema.parse(row.answerKey),
  };
}

export type RevisionOptions = {
  /**
   * The image the new revision shows. Omitted: keep the previous revision's image (so editing a
   * question never drops it by accident). An object: use that image. `null`: remove it. The
   * caller must already have checked that the image belongs to the question's owner.
   */
  image?: QuestionImageInput | null;
  /**
   * The source passages the new revision cites. Omitted: carry the previous revision's links
   * over, so editing a question never drops where it came from. An array replaces them.
   */
  sourceLinks?: {
    segmentId: string;
    excerpt?: string | null;
    relationship: "origin" | "evidence";
  }[];
};

/**
 * Appends a new revision to a question and makes it current. Existing revisions are never
 * modified, so earlier attempts keep pointing at what the student actually answered. The image
 * link is carried forward or replaced in the same transaction.
 */
export async function addRevision(
  db: Database,
  questionId: string,
  input: NewRevision,
  options: RevisionOptions = {},
) {
  const validated = parseRevisionJson({ ...input, options: input.options ?? [] });
  return db.transaction(async (tx) => {
    // Serialize concurrent edits of one question so revision numbers never collide.
    await tx
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.id, questionId))
      .for("update");
    const [latest] = await tx
      .select({ n: max(questionRevisions.revisionNumber) })
      .from(questionRevisions)
      .where(eq(questionRevisions.questionId, questionId));
    const [revision] = await tx
      .insert(questionRevisions)
      .values({ ...validated, questionId, revisionNumber: (latest?.n ?? 0) + 1 })
      .returning();

    let link: { imageId: string; altText: string } | undefined;
    if (options.image === undefined) {
      if (latest?.n) {
        const [previous] = await tx
          .select({
            imageId: questionRevisionImages.imageId,
            altText: questionRevisionImages.altText,
          })
          .from(questionRevisionImages)
          .innerJoin(
            questionRevisions,
            eq(questionRevisionImages.questionRevisionId, questionRevisions.id),
          )
          .where(
            and(
              eq(questionRevisions.questionId, questionId),
              eq(questionRevisions.revisionNumber, latest.n),
            ),
          );
        link = previous;
      }
    } else if (options.image !== null) {
      link = { imageId: options.image.imageId, altText: options.image.alt };
    }
    if (link) {
      await tx.insert(questionRevisionImages).values({ questionRevisionId: revision!.id, ...link });
    }
    if (options.sourceLinks) {
      if (options.sourceLinks.length > 0) {
        await tx.insert(questionSourceLinks).values(
          options.sourceLinks.map((l) => ({
            questionRevisionId: revision!.id,
            sourceSegmentId: l.segmentId,
            relationship: l.relationship,
            excerpt: l.excerpt ?? null,
          })),
        );
      }
    } else if (latest?.n) {
      const previousLinks = await tx
        .select({
          sourceSegmentId: questionSourceLinks.sourceSegmentId,
          relationship: questionSourceLinks.relationship,
          excerpt: questionSourceLinks.excerpt,
        })
        .from(questionSourceLinks)
        .innerJoin(
          questionRevisions,
          eq(questionSourceLinks.questionRevisionId, questionRevisions.id),
        )
        .where(
          and(
            eq(questionRevisions.questionId, questionId),
            eq(questionRevisions.revisionNumber, latest.n),
          ),
        );
      if (previousLinks.length > 0) {
        await tx
          .insert(questionSourceLinks)
          .values(previousLinks.map((l) => ({ ...l, questionRevisionId: revision!.id })));
      }
    }
    await tx
      .update(questions)
      .set({ currentRevisionId: revision!.id })
      .where(eq(questions.id, questionId));
    return revision!;
  });
}

export async function getRevision(db: Database, questionId: string, revisionNumber: number) {
  const [row] = await db
    .select()
    .from(questionRevisions)
    .where(
      and(
        eq(questionRevisions.questionId, questionId),
        eq(questionRevisions.revisionNumber, revisionNumber),
      ),
    );
  return row ? parseRevisionJson(row) : undefined;
}
