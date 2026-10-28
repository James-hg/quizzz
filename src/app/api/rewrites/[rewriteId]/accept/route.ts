import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { acceptRewrite, acceptRewriteSchema } from "@/server/content/rewrites";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ rewriteId: string }> };

/**
 * Accepting is your review: send `{ "confirmed": true }`. By default it becomes a new revision of
 * the question; `"as": "new_question"` adds it as a separate question instead. Safe to retry.
 */
export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).rewriteId, "Proposal");
  const input = await readJson(request, acceptRewriteSchema);
  const { replayed, question } = await acceptRewrite(getDb(), user.id, id, input);
  return NextResponse.json({ question }, { status: replayed ? 200 : 201 });
});
