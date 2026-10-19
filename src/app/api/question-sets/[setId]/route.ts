import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { renameQuestionSetSchema } from "@/lib/schemas";
import {
  deleteQuestionSet,
  getQuestionSet,
  renameQuestionSet,
} from "@/server/content/question-sets";

type Ctx = { params: Promise<{ setId: string }> };

export const GET = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).setId, "Question set");
  return NextResponse.json({ questionSet: await getQuestionSet(getDb(), user.id, id) });
});

export const PATCH = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).setId, "Question set");
  const { title } = await readJson(request, renameQuestionSetSchema);
  return NextResponse.json({ questionSet: await renameQuestionSet(getDb(), user.id, id, title) });
});

export const DELETE = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).setId, "Question set");
  await deleteQuestionSet(getDb(), user.id, id);
  return new NextResponse(null, { status: 204 });
});
