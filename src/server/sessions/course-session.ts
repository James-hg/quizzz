import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { CourseSessionInput } from "@/lib/schemas";
import { assertOwnsCourse } from "@/server/auth/ownership";
import type { Database } from "@/server/db";
import { studySessions } from "@/server/db/schema";
import { conflict } from "@/server/http/errors";
import { planSession, type Plan } from "@/server/planner";
import { courseCounts, loadPlanningData } from "@/server/planner/queries";
import { buildSessionView } from "./view";

const isUniqueViolation = (error: unknown) =>
  (error as { cause?: { code?: string } }).cause?.code === "23505";

async function findLiveCourseSession(
  db: Database,
  userId: string,
  courseId: string,
  mode: CourseSessionInput["mode"],
) {
  const [row] = await db
    .select()
    .from(studySessions)
    .where(
      and(
        eq(studySessions.userId, userId),
        eq(studySessions.courseId, courseId),
        eq(studySessions.mode, mode),
        isNull(studySessions.questionSetId),
        inArray(studySessions.state, ["active", "paused"]),
      ),
    );
  return row;
}

/**
 * Starts a planned review or exam session over a course, or resumes the one already running.
 * The questions, their order and their revisions are fixed now, so a resumed session never
 * changes what it asks or how long it is allowed to take. Review retries wrong answers once;
 * exam withholds results until it ends. Neither can be overridden by the client.
 */
export async function startOrResumeCourseSession(
  db: Database,
  userId: string,
  input: CourseSessionInput,
  now: Date = new Date(),
): Promise<{
  created: boolean;
  session: Awaited<ReturnType<typeof buildSessionView>>;
  plan?: Plan;
}> {
  await assertOwnsCourse(db, userId, input.courseId);

  const existing = await findLiveCourseSession(db, userId, input.courseId, input.mode);
  if (existing) return { created: false, session: await buildSessionView(db, existing, now) };

  const data = await loadPlanningData(db, userId, input.courseId, now);
  const plan = planSession({
    candidates: data.candidates,
    mode: input.mode,
    budgetMinutes: input.timeBudgetMinutes,
    estimatedSecondsPerItem: data.secondsPerItem,
    params: data.params,
  });
  if (plan.items.length === 0) {
    // The counts say why: nothing to practise, or everything waiting for review.
    throw conflict("This course has no questions that can be practiced.", "no_playable_questions", {
      ...(await courseCounts(db, userId, input.courseId)),
    });
  }

  try {
    const [row] = await db
      .insert(studySessions)
      .values({
        userId,
        courseId: input.courseId,
        questionSetId: null,
        mode: input.mode,
        state: "active",
        timeBudgetMinutes: input.timeBudgetMinutes,
        revealMode: input.mode === "exam" ? "end" : "requeue",
        itemOrder: plan.items.map((i) => i.questionId),
        revisionIds: Object.fromEntries(plan.items.map((i) => [i.questionId, i.revisionId])),
        policyVersion: data.policyVersion,
        startedAt: now,
        activeStartedAt: now,
      })
      .returning();
    return { created: true, session: await buildSessionView(db, row!, now), plan };
  } catch (error) {
    // Another request created the live session first; return that one.
    if (!isUniqueViolation(error)) throw error;
    const raced = await findLiveCourseSession(db, userId, input.courseId, input.mode);
    if (!raced) throw error;
    return { created: false, session: await buildSessionView(db, raced, now) };
  }
}
