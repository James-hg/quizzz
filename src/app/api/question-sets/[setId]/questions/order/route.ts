import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { reorderSchema } from "@/lib/schemas";
import { reorderQuestions } from "@/server/content/questions";

type Ctx = { params: Promise<{ setId: string }> };

export const PUT = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).setId, "Question set");
  const { questionIds } = await readJson(request, reorderSchema);
  return NextResponse.json({
    questions: await reorderQuestions(getDb(), user.id, id, questionIds),
  });
});
