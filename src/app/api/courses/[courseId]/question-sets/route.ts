import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createQuestionSetSchema } from "@/lib/schemas";
import { createQuestionSet, listQuestionSets } from "@/server/content/question-sets";

type Ctx = { params: Promise<{ courseId: string }> };

export const GET = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).courseId, "Course");
  return NextResponse.json({ questionSets: await listQuestionSets(getDb(), user.id, id) });
});

export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).courseId, "Course");
  const { title } = await readJson(request, createQuestionSetSchema);
  const questionSet = await createQuestionSet(getDb(), user.id, id, title);
  return NextResponse.json({ questionSet }, { status: 201 });
});
