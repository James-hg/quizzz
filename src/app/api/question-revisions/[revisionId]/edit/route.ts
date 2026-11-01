import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { editRevision, editSchema } from "@/server/content-checks/review";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ revisionId: string }> };

/** Edits a generated or sample question and its citations; it stays waiting for review. */
export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const revisionId = parseId((await params).revisionId, "Question");
  const input = await readJson(request, editSchema);
  const question = await editRevision(getDb(), user.id, revisionId, input);
  return NextResponse.json({ question });
});
