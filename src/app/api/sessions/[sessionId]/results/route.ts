import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId } from "@/server/http/request";
import { getSessionResults } from "@/server/sessions/results";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

/** The report for a finished session (409 while it is still running, so exams stay concealed). */
export const GET = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const sessionId = parseId((await params).sessionId, "Session");
  return NextResponse.json({ results: await getSessionResults(getDb(), user.id, sessionId) });
});
