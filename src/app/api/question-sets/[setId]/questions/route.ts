import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createQuestionSchema } from "@/lib/schemas";
import { createQuestion, listQuestions } from "@/server/content/questions";

type Ctx = { params: Promise<{ setId: string }> };

export const GET = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).setId, "Question set");
  return NextResponse.json({ questions: await listQuestions(getDb(), user.id, id) });
});

export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).setId, "Question set");
  const { approve, image, ...content } = await readJson(request, createQuestionSchema);
  const question = await createQuestion(getDb(), user.id, id, content, approve, image);
  return NextResponse.json({ question }, { status: 201 });
});
