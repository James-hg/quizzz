import "server-only";
import { and, eq, max } from "drizzle-orm";
import { answerKeySchema, optionsSchema } from "@/lib/schemas";
import type { Database } from "../index";
import { questionRevisions, questions } from "../schema";

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

/**
 * Appends a new revision to a question and makes it current. Existing revisions are never
 * modified, so earlier attempts keep pointing at what the student actually answered.
 */
export async function addRevision(db: Database, questionId: string, input: NewRevision) {
  const validated = parseRevisionJson({ ...input, options: input.options ?? [] });
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ n: max(questionRevisions.revisionNumber) })
      .from(questionRevisions)
      .where(eq(questionRevisions.questionId, questionId));
    const [revision] = await tx
      .insert(questionRevisions)
      .values({ ...validated, questionId, revisionNumber: (latest?.n ?? 0) + 1 })
      .returning();
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
