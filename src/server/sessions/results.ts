import "server-only";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { assertOwnsSession } from "@/server/auth/ownership";
import type { Database } from "@/server/db";
import {
  attempts,
  questionRevisions,
  questionSets,
  questions,
  reviewStates,
} from "@/server/db/schema";
import { conflict } from "@/server/http/errors";
import { elapsedSecondsAt } from "./view";

type Outcome = "correct" | "incorrect" | "uncertain";

export type AttemptFact = {
  questionId: string;
  pass: number;
  outcome: Outcome;
  role: "scored" | "prequestion" | "practice";
  assistance: string;
};

type Tally = {
  answered: number;
  /** Right, with or without help. */
  correct: number;
  /** Right on a first, scored try with no help at all: the only kind that counts as independent. */
  independentCorrect: number;
  /** Right, but only after help. A different kind of evidence, kept apart. */
  assistedCorrect: number;
  incorrect: number;
  /** Could not be checked automatically. Never counted as a failure. */
  uncertain: number;
};

const empty = (): Tally => ({
  answered: 0,
  correct: 0,
  independentCorrect: 0,
  assistedCorrect: 0,
  incorrect: 0,
  uncertain: 0,
});

/**
 * Counts attempts. First tries (pass 1) and retries (pass 2) are tallied apart, because a
 * retry follows a verdict the student already saw. Used by both the completion summary and the
 * results endpoint so they cannot disagree.
 */
export function tallyAttempts(facts: readonly AttemptFact[]): { first: Tally; retry: Tally } {
  const first = empty();
  const retry = empty();
  for (const fact of facts) {
    const t = fact.pass === 1 ? first : retry;
    t.answered += 1;
    if (fact.outcome === "incorrect") t.incorrect += 1;
    else if (fact.outcome === "uncertain") t.uncertain += 1;
    else {
      t.correct += 1;
      if (fact.pass === 1 && fact.role === "scored" && fact.assistance === "none") {
        t.independentCorrect += 1;
      } else t.assistedCorrect += 1;
    }
  }
  return { first, retry };
}

export async function loadAttemptFacts(db: Database, sessionId: string): Promise<AttemptFact[]> {
  const rows = await db
    .select({
      questionId: attempts.questionId,
      pass: attempts.pass,
      outcome: attempts.gradingOutcome,
      role: attempts.activityRole,
      assistance: attempts.assistanceLevel,
    })
    .from(attempts)
    .where(eq(attempts.sessionId, sessionId));
  return rows;
}

/**
 * The finished-session report. Only available once the session has ended: an exam must not
 * reveal how a student is doing while they are still answering.
 */
export async function getSessionResults(
  db: Database,
  userId: string,
  sessionId: string,
  now = new Date(),
) {
  const session = await assertOwnsSession(db, userId, sessionId);
  if (session.state === "active" || session.state === "paused") {
    throw conflict("Results are available when the session ends.", "session_in_progress");
  }

  const rows = await db
    .select({
      questionId: attempts.questionId,
      pass: attempts.pass,
      outcome: attempts.gradingOutcome,
      role: attempts.activityRole,
      assistance: attempts.assistanceLevel,
      // Where the question came from is read from the revision the student actually answered.
      origin: questionRevisions.origin,
      questionSetId: questionSets.id,
      questionSetTitle: questionSets.title,
    })
    .from(attempts)
    .innerJoin(questionRevisions, eq(attempts.questionRevisionId, questionRevisions.id))
    .innerJoin(questions, eq(attempts.questionId, questions.id))
    .innerJoin(questionSets, eq(questions.questionSetId, questionSets.id))
    .where(eq(attempts.sessionId, sessionId));

  const { first, retry } = tallyAttempts(rows);

  const questionIds = new Set(rows.map((r) => r.questionId));
  const originOf = new Map(rows.map((r) => [r.questionId, r.origin]));
  const generated = [...originOf.values()].filter((o) => o === "ai_proposed" || o === "ai_variant");

  // Question sets where first tries went wrong, needed help, or could not be checked. These are
  // question sets, not topics: topic tags arrive with the concept work (C8).
  const needs = new Map<
    string,
    { questionSetId: string; title: string; missed: number; assisted: number; unchecked: number }
  >();
  for (const r of rows) {
    if (r.pass !== 1 || (r.outcome === "correct" && r.assistance === "none")) continue;
    const entry = needs.get(r.questionSetId) ?? {
      questionSetId: r.questionSetId,
      title: r.questionSetTitle,
      missed: 0,
      assisted: 0,
      unchecked: 0,
    };
    if (r.outcome === "incorrect") entry.missed += 1;
    else if (r.outcome === "uncertain") entry.unchecked += 1;
    else entry.assisted += 1;
    needs.set(r.questionSetId, entry);
  }

  const removed = session.itemOrder.filter((id) => !session.revisionIds[id]).length;

  // The soonest planned review of anything in this course, from the student's own schedule.
  const [next] = await db
    .select({ at: sql<Date | null>`min(${reviewStates.nextDueAt})` })
    .from(reviewStates)
    .innerJoin(questions, eq(reviewStates.questionId, questions.id))
    .innerJoin(questionSets, eq(questions.questionSetId, questionSets.id))
    .where(
      and(
        eq(reviewStates.userId, userId),
        eq(questionSets.courseId, session.courseId),
        ne(reviewStates.state, "suspended"),
        isNotNull(reviewStates.nextDueAt),
      ),
    );

  return {
    sessionId: session.id,
    mode: session.mode,
    revealMode: session.revealMode,
    state: session.state,
    timeBudgetMinutes: session.timeBudgetMinutes,
    elapsedSeconds: elapsedSecondsAt(session, now),
    // Distinct questions the student answered, against all answers including retries.
    uniqueQuestions: questionIds.size,
    attempts: rows.length,
    firstPass: {
      answered: first.answered,
      independentCorrect: first.independentCorrect,
      assistedCorrect: first.assistedCorrect,
      incorrect: first.incorrect,
      uncertain: first.uncertain,
      unanswered: session.itemOrder.length - removed - first.answered,
    },
    retry: {
      total: session.retryOrder.length,
      answered: retry.answered,
      correct: retry.correct,
      incorrect: retry.incorrect,
      uncertain: retry.uncertain,
    },
    originalQuestions: questionIds.size - generated.length,
    generatedQuestions: generated.length,
    questionSetsNeedingPractice: [...needs.values()].sort(
      (a, b) => b.missed + b.assisted - (a.missed + a.assisted) || (a.title < b.title ? -1 : 1),
    ),
    nextReviewAt: next?.at ? new Date(next.at).toISOString() : null,
  };
}
