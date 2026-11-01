import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getReviewQueue } from "@/server/content-checks/review";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ courseId: string }> };

/**
 * Everything in a course that waits for the owner's decision: generated and sample questions,
 * and pending AI rewrites, each with the checks made on it. Answer keys are included, so this is
 * for the owner only and is never cached.
 */
export const GET = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const courseId = parseId((await params).courseId, "Course");
  const queue = await getReviewQueue(getDb(), user.id, courseId);
  return NextResponse.json(queue, { headers: { "Cache-Control": "private, no-store" } });
});
