import "server-only";
import { desc, eq } from "drizzle-orm";
import type { z } from "zod";
import type { createCourseSchema, updateCourseSchema } from "@/lib/schemas";
import { assertOwnsCourse } from "@/server/auth/ownership";
import type { Database } from "@/server/db";
import { courses, questionSets, studySessions } from "@/server/db/schema";
import { hasHistoryError, purgeQuestionSets, setsHaveAttempts } from "./history";

export async function listCourses(db: Database, userId: string) {
  return db
    .select()
    .from(courses)
    .where(eq(courses.ownerId, userId))
    .orderBy(desc(courses.updatedAt));
}

export async function createCourse(
  db: Database,
  userId: string,
  input: z.infer<typeof createCourseSchema>,
) {
  const [row] = await db
    .insert(courses)
    .values({
      ownerId: userId,
      title: input.title,
      subject: input.subject,
      language: input.language ?? null,
      examDate: input.examDate ?? null,
    })
    .returning();
  return row!;
}

export const getCourse = assertOwnsCourse;

export async function updateCourse(
  db: Database,
  userId: string,
  courseId: string,
  input: z.infer<typeof updateCourseSchema>,
) {
  await assertOwnsCourse(db, userId, courseId);
  const [row] = await db
    .update(courses)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(courses.id, courseId))
    .returning();
  return row!;
}

/**
 * Hard delete is allowed only when nothing in the course was ever attempted (decision: no
 * soft-archive; questions with history are retired with `excluded`). Otherwise 409 has_history.
 */
export async function deleteCourse(db: Database, userId: string, courseId: string) {
  await assertOwnsCourse(db, userId, courseId);
  const sets = await db
    .select({ id: questionSets.id })
    .from(questionSets)
    .where(eq(questionSets.courseId, courseId));
  const setIds = sets.map((s) => s.id);
  if (await setsHaveAttempts(db, setIds)) throw hasHistoryError();
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    await purgeQuestionSets(database, setIds);
    await database.delete(studySessions).where(eq(studySessions.courseId, courseId));
    await database.delete(courses).where(eq(courses.id, courseId));
  });
}
