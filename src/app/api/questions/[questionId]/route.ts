import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { patchQuestionSchema } from "@/lib/schemas";
import { deleteQuestion, getQuestion, updateQuestion } from "@/server/content/questions";

type Ctx = { params: Promise<{ questionId: string }> };

export const GET = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).questionId, "Question");
  return NextResponse.json({ question: await getQuestion(getDb(), user.id, id) });
});

/** Creates a new revision; earlier revisions and attempts are untouched. */
export const PATCH = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).questionId, "Question");
  const patch = await readJson(request, patchQuestionSchema);
  return NextResponse.json({ question: await updateQuestion(getDb(), user.id, id, patch) });
});

export const DELETE = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).questionId, "Question");
  await deleteQuestion(getDb(), user.id, id);
  return new NextResponse(null, { status: 204 });
});
