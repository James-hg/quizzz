import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/server/db";
import {
  attempts,
  helpEvents,
  questionRevisions,
  questionSets,
  questionSourceLinks,
  questions,
  studySessions,
} from "@/server/db/schema";
import { conflict } from "@/server/http/errors";
import { deleteUnlinkedImages, imageIdsOfRevisions } from "@/server/images/service";
import { getStorage } from "@/server/storage";

/**
 * True if any question in these sets has study history: it was attempted, or a student asked
 * for help on it (a help event is evidence of what they were shown, even before an answer).
 */
export async function setsHaveAttempts(db: Database, setIds: string[]): Promise<boolean> {
  if (setIds.length === 0) return false;
  const [attempted] = await db
    .select({ one: sql<number>`1` })
    .from(attempts)
    .innerJoin(questions, eq(attempts.questionId, questions.id))
    .where(inArray(questions.questionSetId, setIds))
    .limit(1);
  if (attempted) return true;
  const [helped] = await db
    .select({ one: sql<number>`1` })
    .from(helpEvents)
    .innerJoin(questions, eq(helpEvents.questionId, questions.id))
    .where(inArray(questions.questionSetId, setIds))
    .limit(1);
  return Boolean(helped);
}

/** True if this question was ever attempted or had help requested. */
export async function questionHasHistory(db: Database, questionId: string): Promise<boolean> {
  const [attempted] = await db
    .select({ one: sql<number>`1` })
    .from(attempts)
    .where(eq(attempts.questionId, questionId))
    .limit(1);
  if (attempted) return true;
  const [helped] = await db
    .select({ one: sql<number>`1` })
    .from(helpEvents)
    .where(eq(helpEvents.questionId, questionId))
    .limit(1);
  return Boolean(helped);
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
  let imageIds: string[] = [];
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
    imageIds = await imageIdsOfRevisions(
      database,
      (
        await database
          .select({ id: questionRevisions.id })
          .from(questionRevisions)
          .where(inArray(questionRevisions.questionId, questionIds))
      ).map((r) => r.id),
    );

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
  // Images that only these questions showed are deleted too (rows and stored bytes).
  await deleteUnlinkedImages(db, getStorage(), imageIds);
}
