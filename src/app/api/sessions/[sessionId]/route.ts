import { NextResponse } from "next/server";
import { patchSessionSchema } from "@/lib/schemas";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";
import { getSession, pauseSession, resumeSession } from "@/server/sessions/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

/** Never includes answer keys, explanations, or correctness for unanswered items. */
export const GET = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).sessionId, "Session");
  return NextResponse.json({ session: await getSession(getDb(), user.id, id) });
});

export const PATCH = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).sessionId, "Session");
  const { action } = await readJson(request, patchSessionSchema);
  const session =
    action === "pause"
      ? await pauseSession(getDb(), user.id, id)
      : await resumeSession(getDb(), user.id, id);
  return NextResponse.json({ session });
});
