import { NextResponse } from "next/server";
import { createSessionSchema } from "@/lib/schemas";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { readJson } from "@/server/http/request";
import { startOrResumeSession } from "@/server/sessions/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resumes the live session for the set (200) or creates one (201). */
export const POST = handleRoute(async (request: Request) => {
  const user = await requireUser(request);
  const { questionSetId, revealMode } = await readJson(request, createSessionSchema);
  const { created, session } = await startOrResumeSession(
    getDb(),
    user.id,
    questionSetId,
    revealMode,
  );
  return NextResponse.json({ session }, { status: created ? 201 : 200 });
});
