import { NextResponse } from "next/server";
import { createSessionSchema } from "@/lib/schemas";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { readJson } from "@/server/http/request";
import type { Plan } from "@/server/planner";
import { startOrResumeCourseSession } from "@/server/sessions/course-session";
import { startOrResumeSession } from "@/server/sessions/service";

/** What the student is told about a freshly planned session: why it looks the way it does. */
const planSummary = (plan: Plan) => ({
  estimatedSeconds: plan.estimatedSeconds,
  reasons: plan.reasons,
  limitedBy: plan.limitedBy,
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Starts or resumes a session. A question-set body is the original practice quiz. A course body
 * (`mode: review | exam` with a time budget) plans a short session across the whole course.
 * Resuming returns 200; a new session returns 201.
 */
export const POST = handleRoute(async (request: Request) => {
  const user = await requireUser(request);
  const input = await readJson(request, createSessionSchema);
  if ("courseId" in input) {
    const { created, session, plan } = await startOrResumeCourseSession(getDb(), user.id, input);
    return NextResponse.json(
      { session, ...(plan ? { plan: planSummary(plan) } : {}) },
      { status: created ? 201 : 200 },
    );
  }
  const { created, session } = await startOrResumeSession(
    getDb(),
    user.id,
    input.questionSetId,
    input.revealMode,
  );
  return NextResponse.json({ session }, { status: created ? 201 : 200 });
});
