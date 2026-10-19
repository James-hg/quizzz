import "server-only";
import { and, eq } from "drizzle-orm";
import type { QuestionResponse, SubmitAnswerInput } from "@/lib/schemas";
import type { Database } from "@/server/db";
import { insertAttempt } from "@/server/db/repositories/attempts";
import { parseRevisionJson } from "@/server/db/repositories/questions";
import { attempts, questionRevisions, studySessions } from "@/server/db/schema";
import { badRequest, conflict, notFound } from "@/server/http/errors";
import { gradeResponse } from "@/server/grading";
import { lockSession } from "./service";
import { firstPendingIndex, resultOf } from "./view";

type RevisionRow = typeof questionRevisions.$inferSelect;

const isUniqueViolation = (error: unknown) =>
  (error as { cause?: { code?: string } }).cause?.code === "23505";

const invalid = (message: string) => badRequest(message, "invalid_response");

/** Rejects responses that do not fit the question, before anything is graded or stored. */
export function validateResponseShape(revision: RevisionRow, response: QuestionResponse) {
  switch (revision.type) {
    case "mcq_single":
    case "mcq_multi": {
      if (response.kind !== "options") throw invalid("Choose from the listed options.");
      const known = new Set(revision.options.map((o) => o.id));
      if (!response.selectedOptionIds.every((id) => known.has(id))) {
        throw invalid("That option does not exist for this question.");
      }
      const distinct = new Set(response.selectedOptionIds).size;
      if (revision.type === "mcq_single" && distinct !== 1)
        throw invalid("Choose exactly one option.");
      if (revision.type === "mcq_multi" && distinct < 1)
        throw invalid("Choose at least one option.");
      return;
    }
    case "short_answer":
    case "output_prediction":
      if (response.kind !== "text") throw invalid("This question takes a text answer.");
      return;
    case "fill_blank": {
      if (response.kind !== "blanks") throw invalid("This question takes one answer per blank.");
      const key = revision.answerKey;
      if (key.kind === "blanks" && response.values.length !== key.blanks.length) {
        throw invalid(`Provide ${key.blanks.length} answers, one per blank.`);
      }
      return;
    }
    default:
      return;
  }
}

async function findByKey(db: Database, userId: string, key: string) {
  const [row] = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.userId, userId), eq(attempts.idempotencyKey, key)));
  return row;
}

async function progressOf(db: Database, sessionId: string, total: number) {
  const rows = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(eq(attempts.sessionId, sessionId));
  return { answered: rows.length, total };
}

async function replay(
  db: Database,
  attempt: typeof attempts.$inferSelect,
  input: SubmitAnswerInput,
  total: number,
) {
  if (attempt.questionId !== input.questionId) {
    throw conflict(
      "That idempotency key was already used for a different answer.",
      "idempotency_key_reused",
    );
  }
  const [revision] = await db
    .select()
    .from(questionRevisions)
    .where(eq(questionRevisions.id, attempt.questionRevisionId));
  return {
    replayed: true,
    result: resultOf(attempt, parseRevisionJson(revision!)),
    progress: await progressOf(db, attempt.sessionId, total),
  };
}

/**
 * Grades and stores one answer. Safe to retry: the same idempotency key returns the stored
 * result and never creates a second attempt. Grading uses the revision pinned to the session.
 */
export async function submitAnswer(
  db: Database,
  userId: string,
  sessionId: string,
  input: SubmitAnswerInput,
  now: Date = new Date(),
) {
  try {
    return await db.transaction(async (tx) => {
      const database = tx as unknown as Database;
      const session = await lockSession(database, userId, sessionId);

      // A retry of something already stored is answered from storage, even after the session
      // ended: the original result is the truth.
      const existing = await findByKey(database, userId, input.idempotencyKey);
      if (existing) {
        if (existing.sessionId !== sessionId) {
          throw conflict(
            "That idempotency key was already used elsewhere.",
            "idempotency_key_reused",
          );
        }
        return replay(database, existing, input, session.itemOrder.length);
      }

      if (session.state === "completed" || session.state === "abandoned") {
        throw conflict("This session has ended.", "session_completed");
      }
      if (session.state === "paused") {
        throw conflict("This session is paused. Resume it to keep answering.", "session_paused");
      }

      if (!session.itemOrder.includes(input.questionId))
        throw notFound("Question not in this session");

      const sessionAttempts = await database
        .select({ questionId: attempts.questionId })
        .from(attempts)
        .where(eq(attempts.sessionId, sessionId));
      if (sessionAttempts.some((a) => a.questionId === input.questionId)) {
        throw conflict("This question was already answered in this session.", "already_answered");
      }

      const revisionId = session.revisionIds[input.questionId];
      const [row] = revisionId
        ? await database
            .select()
            .from(questionRevisions)
            .where(eq(questionRevisions.id, revisionId))
        : [];
      if (!row) throw conflict("This question was removed from the set.", "question_removed");
      const revision = parseRevisionJson(row);

      validateResponseShape(revision, input.response);
      const outcome = gradeResponse(revision, input.response);

      const attempt = await insertAttempt(database, {
        sessionId,
        userId,
        questionId: input.questionId,
        questionRevisionId: revision.id,
        response: input.response,
        isCorrect: outcome === "uncertain" ? null : outcome === "correct",
        gradingOutcome: outcome,
        activityRole: "scored",
        idempotencyKey: input.idempotencyKey,
        startedAt: now,
        submittedAt: now,
      });

      const answered = new Set([...sessionAttempts.map((a) => a.questionId), input.questionId]);
      const nextIndex = firstPendingIndex(
        session.itemOrder.map((id) => ({
          status: answered.has(id) || !session.revisionIds[id] ? "done" : "pending",
        })),
      );
      await database
        .update(studySessions)
        .set({ currentIndex: nextIndex })
        .where(eq(studySessions.id, sessionId));

      return {
        replayed: false,
        result: resultOf(attempt, revision),
        progress: { answered: answered.size, total: session.itemOrder.length },
      };
    });
  } catch (error) {
    // Two requests with the same key raced across sessions; the loser reads the stored attempt.
    if (!isUniqueViolation(error)) throw error;
    const stored = await findByKey(db, userId, input.idempotencyKey);
    if (!stored || stored.sessionId !== sessionId) {
      throw conflict("That idempotency key was already used elsewhere.", "idempotency_key_reused");
    }
    const [session] = await db.select().from(studySessions).where(eq(studySessions.id, sessionId));
    return replay(db, stored, input, session?.itemOrder.length ?? 0);
  }
}
