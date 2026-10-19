import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { listRevisions } from "@/server/content/questions";

type Ctx = { params: Promise<{ questionId: string }> };

export const GET = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).questionId, "Question");
  return NextResponse.json({ revisions: await listRevisions(getDb(), user.id, id) });
});
