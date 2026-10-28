import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { listRewrites, saveRewrite, saveRewriteSchema } from "@/server/content/rewrites";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ questionId: string }> };

/** Pending AI rewrites of this question, newest first. `stale` means the question has since changed. */
export const GET = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).questionId, "Question");
  return NextResponse.json({ rewrites: await listRewrites(getDb(), user.id, id) });
});

/**
 * Saves a proposal for review. No AI call, so this works with AI off. The proposal is checked
 * against the question and does not change it; accepting it is a separate step.
 */
export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).questionId, "Question");
  const input = await readJson(request, saveRewriteSchema);
  return NextResponse.json(
    { rewrite: await saveRewrite(getDb(), user.id, id, input) },
    { status: 201 },
  );
});
