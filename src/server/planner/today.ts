import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "@/server/db";
import { studySessions } from "@/server/db/schema";
import { BUDGET_OPTIONS, planSession, type BudgetMinutes } from "./index";
import { loadPlanningData } from "./queries";

/**
 * "Start today's session": a short recommendation for one course. Metadata only, never answer
 * keys or question text. It previews each time budget so the student can choose, and recommends
 * the shortest one that fits everything that is due today.
 */
export async function recommendToday(
  db: Database,
  userId: string,
  courseId: string,
  now: Date = new Date(),
) {
  const data = await loadPlanningData(db, userId, courseId, now);
  const plans = BUDGET_OPTIONS.map((minutes) => ({
    minutes,
    plan: planSession({
      candidates: data.candidates,
      mode: "review",
      budgetMinutes: minutes,
      estimatedSecondsPerItem: data.secondsPerItem,
      params: data.params,
    }),
  }));

  const dueAvailable = plans[0]!.plan.counts.dueAvailable;
  const recommended: BudgetMinutes =
    plans.find((p) => p.plan.counts.due >= dueAvailable)?.minutes ??
    BUDGET_OPTIONS[BUDGET_OPTIONS.length - 1]!;
  const chosen = plans.find((p) => p.minutes === recommended)!.plan;

  const [live] = await db
    .select({ id: studySessions.id })
    .from(studySessions)
    .where(
      and(
        eq(studySessions.userId, userId),
        eq(studySessions.courseId, courseId),
        eq(studySessions.mode, "review"),
        isNull(studySessions.questionSetId),
        inArray(studySessions.state, ["active", "paused"]),
      ),
    );

  return {
    course: { id: data.course.id, title: data.course.title },
    recommendedBudgetMinutes: recommended,
    estimatedDurationMinutes:
      chosen.items.length > 0 ? Math.max(1, Math.ceil(chosen.estimatedSeconds / 60)) : 0,
    reasons: chosen.reasons,
    budgetOptions: [...BUDGET_OPTIONS],
    options: plans.map(({ minutes, plan }) => ({
      minutes,
      questionCount: plan.items.length,
      limitedBy: plan.limitedBy,
    })),
    availableCount: data.candidates.length,
    dueCount: dueAvailable,
    newCount: plans[0]!.plan.counts.newAvailable,
    deferredDueCount: data.deferredDue,
    limitedBy: chosen.limitedBy,
    ...(live ? { liveSessionId: live.id } : {}),
  };
}
