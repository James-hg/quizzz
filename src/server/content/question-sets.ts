import "server-only";
import { asc, eq } from "drizzle-orm";
import { assertOwnsCourse, assertOwnsQuestionSet } from "@/server/auth/ownership";
import type { Database } from "@/server/db";
import { questionSets } from "@/server/db/schema";
import { hasHistoryError, purgeQuestionSets, setsHaveAttempts } from "./history";

export async function listQuestionSets(db: Database, userId: string, courseId: string) {
  await assertOwnsCourse(db, userId, courseId);
  return db
    .select()
    .from(questionSets)
    .where(eq(questionSets.courseId, courseId))
    .orderBy(asc(questionSets.createdAt));
}

export async function createQuestionSet(
  db: Database,
  userId: string,
  courseId: string,
  title: string,
) {
  await assertOwnsCourse(db, userId, courseId);
  const [row] = await db
    .insert(questionSets)
    .values({ courseId, ownerId: userId, title, origin: "manual" })
    .returning();
  return row!;
}

export const getQuestionSet = assertOwnsQuestionSet;

export async function renameQuestionSet(
  db: Database,
  userId: string,
  setId: string,
  title: string,
) {
  await assertOwnsQuestionSet(db, userId, setId);
  const [row] = await db
    .update(questionSets)
    .set({ title, updatedAt: new Date() })
    .where(eq(questionSets.id, setId))
    .returning();
  return row!;
}

/** Allowed only if no question in the set was ever attempted; otherwise 409 has_history. */
export async function deleteQuestionSet(db: Database, userId: string, setId: string) {
  await assertOwnsQuestionSet(db, userId, setId);
  if (await setsHaveAttempts(db, [setId])) throw hasHistoryError();
  await purgeQuestionSets(db, [setId]);
}
