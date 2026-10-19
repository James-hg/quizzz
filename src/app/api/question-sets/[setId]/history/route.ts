import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId } from "@/server/http/request";
import { listSetHistory } from "@/server/sessions/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ setId: string }> };

export const GET = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).setId, "Question set");
  return NextResponse.json({ sessions: await listSetHistory(getDb(), user.id, id) });
});
