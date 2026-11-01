import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { rejectRevision, rejectSchema } from "@/server/content-checks/review";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ revisionId: string }> };

/** Rejects the current revision: a new rejected revision, out of practice. */
export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const revisionId = parseId((await params).revisionId, "Question");
  await readJson(request, rejectSchema);
  const question = await rejectRevision(getDb(), user.id, revisionId);
  return NextResponse.json({ question });
});
