import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { assertOwnsCourse } from "@/server/auth/ownership";
import type { Database } from "@/server/db";
import {
  attempts,
  courses,
  importDrafts,
  questionSets,
  questions,
  sourceDocuments,
  studySessions,
} from "@/server/db/schema";

/** Question sets with how many questions they hold and how many can be practiced. */
export async function listQuestionSetsWithCounts(db: Database, userId: string, courseId: string) {
  await assertOwnsCourse(db, userId, courseId);
  return db
    .select({
      id: questionSets.id,
      title: questionSets.title,
      origin: questionSets.origin,
      updatedAt: questionSets.updatedAt,
      questionCount: sql<number>`count(${questions.id})::int`,
      playableCount: sql<number>`(count(*) filter (where ${questions.status} = 'active'))::int`,
    })
    .from(questionSets)
    .leftJoin(questions, eq(questions.questionSetId, questionSets.id))
    .where(and(eq(questionSets.courseId, courseId), eq(questionSets.ownerId, userId)))
    .groupBy(questionSets.id)
    .orderBy(asc(questionSets.createdAt));
}

export async function listRecentQuestionSets(db: Database, userId: string, limit = 5) {
  return db
    .select({
      id: questionSets.id,
      title: questionSets.title,
      courseId: courses.id,
      courseTitle: courses.title,
      updatedAt: questionSets.updatedAt,
    })
    .from(questionSets)
    .innerJoin(courses, eq(questionSets.courseId, courses.id))
    .where(eq(questionSets.ownerId, userId))
    .orderBy(desc(questionSets.updatedAt))
    .limit(limit);
}

/** Active or paused sessions the student can pick up again, with progress. */
export async function listLiveSessions(db: Database, userId: string) {
  const rows = await db
    .select({
      sessionId: studySessions.id,
      state: studySessions.state,
      questionSetId: studySessions.questionSetId,
      setTitle: questionSets.title,
      courseTitle: courses.title,
      total: sql<number>`jsonb_array_length(${studySessions.itemOrder})::int`,
      answered: sql<number>`count(${attempts.id})::int`,
    })
    .from(studySessions)
    .innerJoin(questionSets, eq(studySessions.questionSetId, questionSets.id))
    .innerJoin(courses, eq(studySessions.courseId, courses.id))
    .leftJoin(attempts, eq(attempts.sessionId, studySessions.id))
    .where(
      and(eq(studySessions.userId, userId), inArray(studySessions.state, ["active", "paused"])),
    )
    .groupBy(studySessions.id, questionSets.id, courses.id)
    .orderBy(desc(studySessions.startedAt));
  return rows.flatMap((row) =>
    row.questionSetId ? [{ ...row, questionSetId: row.questionSetId }] : [],
  );
}

/** Uploaded materials for a course, newest first, with where they ended up. */
export async function listCourseImports(db: Database, userId: string, courseId: string) {
  await assertOwnsCourse(db, userId, courseId);
  return db
    .select({
      id: importDrafts.id,
      filename: sourceDocuments.filename,
      status: importDrafts.status,
      createdAt: importDrafts.createdAt,
      publishedQuestionSetId: importDrafts.publishedQuestionSetId,
    })
    .from(importDrafts)
    .innerJoin(sourceDocuments, eq(importDrafts.sourceDocumentId, sourceDocuments.id))
    .where(and(eq(importDrafts.courseId, courseId), eq(importDrafts.ownerId, userId)))
    .orderBy(desc(importDrafts.createdAt));
}
