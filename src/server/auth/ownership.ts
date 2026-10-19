import "server-only";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/server/db";
import {
  courses,
  questionSets,
  questions,
  sourceDocuments,
  studySessions,
} from "@/server/db/schema";
import { notFound } from "@/server/http/errors";

/**
 * Each helper resolves a resource only if `userId` owns it. A missing resource and another
 * user's resource are indistinguishable (both 404), so ids never leak existence.
 */

export async function assertOwnsCourse(db: Database, userId: string, courseId: string) {
  const [row] = await db
    .select()
    .from(courses)
    .where(and(eq(courses.id, courseId), eq(courses.ownerId, userId)));
  if (!row) throw notFound("Course not found");
  return row;
}

export async function assertOwnsQuestionSet(db: Database, userId: string, questionSetId: string) {
  const [row] = await db
    .select()
    .from(questionSets)
    .where(and(eq(questionSets.id, questionSetId), eq(questionSets.ownerId, userId)));
  if (!row) throw notFound("Question set not found");
  return row;
}

export async function assertOwnsQuestion(db: Database, userId: string, questionId: string) {
  const [row] = await db
    .select({ question: questions })
    .from(questions)
    .innerJoin(questionSets, eq(questions.questionSetId, questionSets.id))
    .where(and(eq(questions.id, questionId), eq(questionSets.ownerId, userId)));
  if (!row) throw notFound("Question not found");
  return row.question;
}

export async function assertOwnsSession(db: Database, userId: string, sessionId: string) {
  const [row] = await db
    .select()
    .from(studySessions)
    .where(and(eq(studySessions.id, sessionId), eq(studySessions.userId, userId)));
  if (!row) throw notFound("Session not found");
  return row;
}

export async function assertOwnsSourceDocument(db: Database, userId: string, documentId: string) {
  const [row] = await db
    .select()
    .from(sourceDocuments)
    .where(and(eq(sourceDocuments.id, documentId), eq(sourceDocuments.ownerId, userId)));
  if (!row) throw notFound("Document not found");
  return row;
}
