import "server-only";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { assistanceRank, type AssistanceLevel } from "@/lib/schemas";
import type { Database } from "@/server/db";
import { getSchedulerPolicy } from "@/server/db/repositories/scheduler";
import {
  attempts,
  courses,
  helpEvents,
  questionRevisions,
  questionSets,
  questions,
  reviewStates,
  user,
} from "@/server/db/schema";
import {
  applyAttempt,
  isSchedulable,
  NEW_REVIEW_STATE,
  type Applied,
  type ReviewSnapshot,
} from "./core";

type AttemptRow = typeof attempts.$inferSelect;

/** The strongest help a student asked for in one turn that no attempt has claimed yet. */
export async function pendingHelpForTurn(
  db: Database,
  turn: { sessionId: string; questionId: string; pass: number },
) {
  const rows = await db
    .select({ id: helpEvents.id, level: helpEvents.level })
    .from(helpEvents)
    .where(
      and(
        eq(helpEvents.sessionId, turn.sessionId),
        eq(helpEvents.questionId, turn.questionId),
        eq(helpEvents.pass, turn.pass),
        isNull(helpEvents.attemptId),
      ),
    );
  let strongest: AssistanceLevel = "none";
  for (const row of rows) {
    if (assistanceRank(row.level) > assistanceRank(strongest)) strongest = row.level;
  }
  return { ids: rows.map((r) => r.id), strongest };
}

/** Ties help recorded before the answer to the attempt it preceded. Done once, in the same transaction. */
export async function claimHelpEvents(db: Database, attemptId: string, ids: string[]) {
  if (ids.length === 0) return;
  await db.update(helpEvents).set({ attemptId }).where(inArray(helpEvents.id, ids));
}

export const toSnapshot = (row: typeof reviewStates.$inferSelect): ReviewSnapshot => ({
  state: row.state,
  stepIndex: row.stepIndex,
  nextDueAt: row.nextDueAt,
  lastIndependentSuccessAt: row.lastIndependentSuccessAt,
  delayedSuccessCount: row.delayedSuccessCount,
  distinctSuccessDays: row.distinctSuccessDays,
  lapses: row.lapses,
});

/**
 * Applies one stored attempt to the student's review schedule for that question. It must run in
 * the same transaction as the attempt's insertion, and only for a fresh attempt: the caller
 * returns early for an idempotent replay, so a retried submit can never apply twice.
 *
 * Questions that cannot be practised (no answer, excluded, reported, rejected or awaiting
 * review) are not scheduled. Returns null when nothing was scheduled.
 */
export async function applyScheduling(
  db: Database,
  attempt: AttemptRow,
  policyVersion: string,
  now: Date,
): Promise<Applied | null> {
  const [info] = await db
    .select({
      status: questions.status,
      evidenceStatus: questionRevisions.evidenceStatus,
      answerKind: sql<string>`${questionRevisions.answerKey}->>'kind'`,
      examDate: courses.examDate,
      timezone: user.timezone,
    })
    .from(questions)
    .innerJoin(questionRevisions, eq(questions.currentRevisionId, questionRevisions.id))
    .innerJoin(questionSets, eq(questions.questionSetId, questionSets.id))
    .innerJoin(courses, eq(questionSets.courseId, courses.id))
    .innerJoin(user, eq(user.id, attempt.userId))
    .where(eq(questions.id, attempt.questionId));
  if (!info || !isSchedulable(info)) return null;

  const policy = await getSchedulerPolicy(db, policyVersion);
  if (!policy) throw new Error(`Unknown scheduler policy ${policyVersion}`);

  await db
    .insert(reviewStates)
    .values({ userId: attempt.userId, questionId: attempt.questionId, policyVersion })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(reviewStates)
    .where(
      and(eq(reviewStates.userId, attempt.userId), eq(reviewStates.questionId, attempt.questionId)),
    )
    .for("update");
  const current = row ? toSnapshot(row) : NEW_REVIEW_STATE;

  // When the student last saw this question or help for it, before this attempt.
  const [lastAttempt] = await db
    .select({ at: attempts.submittedAt })
    .from(attempts)
    .where(
      and(
        eq(attempts.userId, attempt.userId),
        eq(attempts.questionId, attempt.questionId),
        ne(attempts.id, attempt.id),
      ),
    )
    .orderBy(desc(attempts.submittedAt))
    .limit(1);
  const [lastHelp] = await db
    .select({ at: helpEvents.createdAt })
    .from(helpEvents)
    .where(
      and(eq(helpEvents.userId, attempt.userId), eq(helpEvents.questionId, attempt.questionId)),
    )
    .orderBy(desc(helpEvents.createdAt))
    .limit(1);
  const exposures = [lastAttempt?.at, lastHelp?.at].filter((d): d is Date => Boolean(d));
  const lastExposureAt = exposures.length
    ? new Date(Math.max(...exposures.map((d) => d.getTime())))
    : null;

  const applied = applyAttempt(
    current,
    {
      outcome: attempt.gradingOutcome,
      pass: attempt.pass,
      activityRole: attempt.activityRole,
      assistance: attempt.assistanceLevel,
      lastExposureAt,
    },
    policy.config,
    now,
    info.timezone,
    info.examDate,
  );

  if (applied.changed) {
    await db
      .update(reviewStates)
      .set({
        ...applied.state,
        policyVersion,
        lastReason: applied.reason,
        lastAttemptId: attempt.id,
        updatedAt: now,
      })
      .where(
        and(
          eq(reviewStates.userId, attempt.userId),
          eq(reviewStates.questionId, attempt.questionId),
        ),
      );
  }
  return applied;
}
