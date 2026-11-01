import "server-only";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { emptyCounts, PLAY_BLOCKING_EVIDENCE, type PlayabilityCounts } from "@/lib/playability";
import { DEFAULT_POLICY_VERSION } from "@/lib/schemas";
import { assertOwnsCourse } from "@/server/auth/ownership";
import { playabilityBySet } from "@/server/content/playability";
import type { Database } from "@/server/db";
import { getSchedulerPolicy } from "@/server/db/repositories/scheduler";
import {
  attempts,
  questionRevisions,
  questionSets,
  questions,
  reviewStates,
  studySessions,
  user,
} from "@/server/db/schema";
import { dueItems } from "@/server/scheduler/core";
import { toSnapshot } from "@/server/scheduler/repository";
import {
  estimateSecondsPerItem,
  plannerParamsFor,
  type Candidate,
  type PlannerParams,
} from "./index";

export type PlanningData = {
  course: Awaited<ReturnType<typeof assertOwnsCourse>>;
  candidates: Candidate[];
  secondsPerItem: number;
  params: PlannerParams;
  policyVersion: string;
  /** Due today beyond the scheduler's daily cap: pushed to later days, not planned. */
  deferredDue: number;
};

/** First-pass answers per completed session, needed before the student's own pace is trusted. */
const MIN_ANSWERS_FOR_PACE = 3;
const PACE_SESSIONS = 20;

/**
 * Seconds per answered question in the student's recent completed sessions: active time divided
 * by first-try answers. An average per session, not a per-question timer.
 */
export async function observedPaces(db: Database, userId: string): Promise<number[]> {
  const rows = await db
    .select({
      elapsed: studySessions.elapsedSeconds,
      answered: sql<number>`(count(*) filter (where ${attempts.pass} = 1))::int`,
    })
    .from(studySessions)
    .innerJoin(attempts, eq(attempts.sessionId, studySessions.id))
    .where(and(eq(studySessions.userId, userId), eq(studySessions.state, "completed")))
    .groupBy(studySessions.id)
    .orderBy(sql`${studySessions.completedAt} desc`)
    .limit(PACE_SESSIONS);
  return rows
    .filter((r) => r.answered >= MIN_ANSWERS_FOR_PACE && r.elapsed > 0)
    .map((r) => r.elapsed / r.answered);
}

/**
 * Everything the planner needs for one course: the playable questions (the same rule practice
 * uses), which of them the review scheduler says are due, how often each was answered, and the
 * student's pace. Only the owner's course is read.
 */
export async function loadPlanningData(
  db: Database,
  userId: string,
  courseId: string,
  now: Date,
  policyVersion: string = DEFAULT_POLICY_VERSION,
): Promise<PlanningData> {
  const course = await assertOwnsCourse(db, userId, courseId);
  const [owner] = await db
    .select({ timezone: user.timezone })
    .from(user)
    .where(eq(user.id, userId));

  const playable = await db
    .select({
      questionId: questions.id,
      revisionId: questions.currentRevisionId,
      questionSetId: questionSets.id,
      questionSetTitle: questionSets.title,
      position: questions.position,
    })
    .from(questions)
    .innerJoin(questionSets, eq(questions.questionSetId, questionSets.id))
    .innerJoin(questionRevisions, eq(questions.currentRevisionId, questionRevisions.id))
    .where(
      and(
        eq(questionSets.courseId, courseId),
        eq(questionSets.ownerId, userId),
        eq(questions.status, "active"),
        notInArray(questionRevisions.evidenceStatus, [...PLAY_BLOCKING_EVIDENCE]),
      ),
    )
    .orderBy(asc(questionSets.title), asc(questions.position));
  const ids = playable.map((q) => q.questionId);

  const policy = await getSchedulerPolicy(db, policyVersion);
  if (!policy) throw new Error(`Unknown scheduler policy ${policyVersion}`);

  const states = ids.length
    ? await db
        .select()
        .from(reviewStates)
        .where(and(eq(reviewStates.userId, userId), inArray(reviewStates.questionId, ids)))
    : [];
  const due = dueItems(
    states.map((row) => ({ ...toSnapshot(row), questionId: row.questionId })),
    now,
    owner?.timezone ?? "UTC",
    course.examDate,
    policy.config,
  );
  const dueById = new Map(due.today.map((d) => [d.questionId, d]));
  const stateById = new Map(states.map((row) => [row.questionId, row.state]));

  const stats = ids.length
    ? await db.execute<{ question_id: string; attempts: number; last_outcome: string }>(sql`
        select question_id,
               count(*)::int as attempts,
               (array_agg(grading_outcome::text order by submitted_at desc))[1] as last_outcome
        from attempts
        where user_id = ${userId}
          and pass = 1
          and activity_role = 'scored'
          and question_id in (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})
        group by question_id`)
    : [];
  const statsById = new Map(Array.from(stats, (r) => [r.question_id, r]));

  const params = plannerParamsFor(policyVersion);
  const candidates: Candidate[] = playable.flatMap((q) => {
    if (!q.revisionId) return [];
    const item = dueById.get(q.questionId);
    const stat = statsById.get(q.questionId);
    return [
      {
        questionId: q.questionId,
        revisionId: q.revisionId,
        questionSetId: q.questionSetId,
        questionSetTitle: q.questionSetTitle,
        position: q.position,
        due: item
          ? {
              reason: item.reason,
              daysOverdue: item.daysOverdue,
              // The scheduler relearns items the student missed or needed help with.
              relearning: stateById.get(q.questionId) === "learning",
            }
          : null,
        scoredAttempts: stat?.attempts ?? 0,
        lastFirstTryMissed: stat?.last_outcome === "incorrect",
      },
    ];
  });

  return {
    course,
    candidates,
    secondsPerItem: estimateSecondsPerItem(await observedPaces(db, userId), params),
    params,
    policyVersion,
    deferredDue: due.deferred.length,
  };
}

/** Per-reason counts across a whole course, for an honest "nothing to practise" answer. */
export async function courseCounts(
  db: Database,
  userId: string,
  courseId: string,
): Promise<PlayabilityCounts> {
  await assertOwnsCourse(db, userId, courseId);
  const sets = await db
    .select({ id: questionSets.id })
    .from(questionSets)
    .where(and(eq(questionSets.courseId, courseId), eq(questionSets.ownerId, userId)));
  const bySet = await playabilityBySet(
    db,
    sets.map((s) => s.id),
  );
  const total = emptyCounts();
  for (const c of bySet.values()) {
    total.total += c.total;
    total.playable += c.playable;
    total.needsReview += c.needsReview;
    total.noAnswer += c.noAnswer;
    total.excluded += c.excluded;
  }
  return total;
}
