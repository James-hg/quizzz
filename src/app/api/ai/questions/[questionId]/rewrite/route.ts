import { NextResponse } from "next/server";
import { rewriteRequestSchema } from "@/lib/rewrite";
import { generateRewrite, prepareRewrite } from "@/server/ai/rewrite";
import { requireAi, withAiOperation } from "@/server/ai/guard";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ questionId: string }> };

/**
 * Proposes a rewrite of one of your questions. Nothing is saved: the proposal comes back for you
 * to review, and the question keeps its current revision. Save it with
 * `POST /api/questions/:id/rewrites`.
 */
export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const { user, provider } = await requireAi(request);
  const questionId = parseId((await params).questionId, "Question");
  const input = await readJson(request, rewriteRequestSchema);
  const db = getDb();
  // Ownership and the "has an answer / has numbers" checks come before quota is spent.
  const prepared = await prepareRewrite(db, user.id, questionId, input.mode);
  const proposal = await withAiOperation(
    db,
    { userId: user.id, route: "rewrite" },
    provider,
    (metered) => generateRewrite(metered, prepared, input),
  );
  return NextResponse.json({ proposal });
});
