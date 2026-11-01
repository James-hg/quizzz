import "server-only";
import { and, eq } from "drizzle-orm";
import type { QuestionResponse, SubmitAnswerInput } from "@/lib/schemas";
import type { Database } from "@/server/db";
import { insertAttempt } from "@/server/db/repositories/attempts";
import { parseRevisionJson } from "@/server/db/repositories/questions";
import { attempts, questionRevisions, studySessions } from "@/server/db/schema";
import { badRequest, conflict, notFound } from "@/server/http/errors";
import { gradeResponse } from "@/server/grading";
import {
  applyScheduling,
  claimHelpEvents,
  pendingHelpForTurn,
} from "@/server/scheduler/repository";
import { lockSession } from "./service";
import { disclosureFor, isEnded, shouldRequeue, type Pass } from "./reveal";
import {
  elapsedSecondsAt,
  firstPendingIndex,
  resultOf,
  sessionSlots,
  type SessionRow,
} from "./view";

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
  session: SessionRow,
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
  const [retry] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        eq(attempts.sessionId, session.id),
        eq(attempts.questionId, attempt.questionId),
        eq(attempts.pass, 2),
      ),
    );
  // Disclosed exactly as a fresh submission would be now: a replay never reveals more than the
  // session's mode allows at this moment, and shows everything once the session has ended.
  const disclosure = disclosureFor({
    mode: session.revealMode,
    sessionEnded: isEnded(session.state),
    pass: attempt.pass as Pass,
    outcome: attempt.gradingOutcome,
    retryAnswered: Boolean(retry),
  });
  return {
    replayed: true,
    sessionEnded: isEnded(session.state),
    result: resultOf(attempt, parseRevisionJson(revision!), disclosure),
    requeued: attempt.pass === 1 && session.retryOrder.includes(attempt.questionId),
    progress: await progressOf(db, attempt.sessionId, sessionSlots(session).length),
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
        return replay(database, existing, input, session);
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
        .select({ questionId: attempts.questionId, pass: attempts.pass })
        .from(attempts)
        .where(eq(attempts.sessionId, sessionId));
      const answeredFirst = sessionAttempts.some(
        (a) => a.questionId === input.questionId && a.pass === 1,
      );
      const answeredRetry = sessionAttempts.some(
        (a) => a.questionId === input.questionId && a.pass === 2,
      );
      // The client says which turn it is answering. Only a question queued for a retry can be
      // answered a second time, once. A mismatch (for example a stale tab submitting a first
      // try after another tab already did) is refused instead of being moved to the next turn.
      const pass: Pass = input.pass;
      const allowed =
        pass === 1
          ? !answeredFirst
          : answeredFirst && session.retryOrder.includes(input.questionId) && !answeredRetry;
      if (!allowed) {
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

      // Help asked for before this answer, recorded as evidence on the attempt itself.
      const help = await pendingHelpForTurn(database, {
        sessionId,
        questionId: input.questionId,
        pass,
      });

      const attempt = await insertAttempt(database, {
        sessionId,
        userId,
        questionId: input.questionId,
        questionRevisionId: revision.id,
        response: input.response,
        isCorrect: outcome === "uncertain" ? null : outcome === "correct",
        gradingOutcome: outcome,
        // A retry follows a verdict the student has already seen, so it is practice, not an
        // independent (scored) answer.
        activityRole: pass === 2 ? "practice" : "scored",
        pass,
        assistanceLevel: help.strongest,
        idempotencyKey: input.idempotencyKey,
        startedAt: now,
        submittedAt: now,
      });

      await claimHelpEvents(database, attempt.id, help.ids);
      // Same transaction as the insert, and this path is skipped for a replayed key, so a retried
      // submit never moves the schedule twice.
      await applyScheduling(database, attempt, session.policyVersion, now);

      // A wrong first answer in requeue mode is asked once more, at the end.
      const retryOrder =
        shouldRequeue(session.revealMode, pass, outcome) &&
        !session.retryOrder.includes(input.questionId)
          ? [...session.retryOrder, input.questionId]
          : session.retryOrder;

      const answered = new Set([
        ...sessionAttempts.map((a) => `${a.questionId}:${a.pass}`),
        `${input.questionId}:${pass}`,
      ]);
      const slots = sessionSlots({ itemOrder: session.itemOrder, retryOrder });
      const nextIndex = firstPendingIndex(
        slots.map((slot) => ({
          status:
            answered.has(`${slot.questionId}:${slot.pass}`) || !session.revisionIds[slot.questionId]
              ? "done"
              : "pending",
        })),
      );
      await database
        .update(studySessions)
        .set({ currentIndex: nextIndex, retryOrder })
        .where(eq(studySessions.id, sessionId));

      // A planned session has a time budget. The answer just stored is always kept; once the
      // active time is used up the session ends here, so no further question is offered. Time
      // while paused is not counted. Nothing is lost: questions not reached stay unanswered
      // and, for review, still due.
      const elapsed = elapsedSecondsAt(session, now);
      const budgetReached =
        session.timeBudgetMinutes !== null && elapsed >= session.timeBudgetMinutes * 60;
      if (budgetReached) {
        await database
          .update(studySessions)
          .set({
            state: "completed",
            elapsedSeconds: elapsed,
            activeStartedAt: null,
            completedAt: now,
          })
          .where(eq(studySessions.id, sessionId));
      }

      return {
        replayed: false,
        // True when this answer used up the time budget: the session is over and results are open.
        sessionEnded: budgetReached,
        result: resultOf(
          attempt,
          revision,
          disclosureFor({
            mode: session.revealMode,
            sessionEnded: budgetReached,
            pass,
            outcome,
            retryAnswered: pass === 2,
          }),
        ),
        requeued: retryOrder.length > session.retryOrder.length,
        progress: { answered: answered.size, total: slots.length },
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
    if (!session) throw error;
    return replay(db, stored, input, session);
  }
}
