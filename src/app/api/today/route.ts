import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { badRequest, handleRoute } from "@/server/http/errors";
import { recommendToday } from "@/server/planner/today";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const courseIdSchema = z.uuid();

/** Today's recommended session for one course: why, how long, and the time budgets to choose from. */
export const GET = handleRoute(async (request: Request) => {
  const user = await requireUser(request);
  // Exactly one courseId: a repeated or missing one is an error, not a silent pick.
  const values = new URL(request.url).searchParams.getAll("courseId");
  const parsed = values.length === 1 ? courseIdSchema.safeParse(values[0]) : null;
  if (!parsed?.success)
    throw badRequest("Provide exactly one courseId (a uuid).", "invalid_course");
  return NextResponse.json(await recommendToday(getDb(), user.id, parsed.data));
});
