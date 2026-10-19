import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/server/db";
import {
  attempts,
  questionRevisions,
  questionSets,
  questionSourceLinks,
  questions,
  studySessions,
} from "@/server/db/schema";
import { conflict } from "@/server/http/errors";

/** True if any question in these sets has ever been attempted. */
export async function setsHaveAttempts(db: Database, setIds: string[]): Promise<boolean> {
  if (setIds.length === 0) return false;
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(attempts)
    .innerJoin(questions, eq(attempts.questionId, questions.id))
    .where(inArray(questions.questionSetId, setIds))
    .limit(1);
  return Boolean(row);
}

export const hasHistoryError = () =>
  conflict(
    "This has study history and cannot be deleted. Exclude its questions instead.",
    "has_history",
  );

/**
 * Removes never-attempted content. Callers must have checked `setsHaveAttempts` first; the
 * database also refuses (FK restrict and revision triggers) if an attempt exists.
 */
export async function purgeQuestionSets(db: Database, setIds: string[]) {
  if (setIds.length === 0) return;
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const questionIds = database
      .select({ id: questions.id })
      .from(questions)
      .where(inArray(questions.questionSetId, setIds));
    const revisionIds = database
      .select({ id: questionRevisions.id })
      .from(questionRevisions)
      .where(inArray(questionRevisions.questionId, questionIds));

    await database
      .update(questions)
      .set({ currentRevisionId: null })
      .where(inArray(questions.questionSetId, setIds));
    await database
      .delete(questionSourceLinks)
      .where(inArray(questionSourceLinks.questionRevisionId, revisionIds));
    await database
      .delete(questionRevisions)
      .where(inArray(questionRevisions.questionId, questionIds));
    await database.delete(questions).where(inArray(questions.questionSetId, setIds));
    // Sessions without attempts only reference these sets; drop them so the FK allows deletion.
    await database.delete(studySessions).where(inArray(studySessions.questionSetId, setIds));
    await database.delete(questionSets).where(inArray(questionSets.id, setIds));
  });
}
