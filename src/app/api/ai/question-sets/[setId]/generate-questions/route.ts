import { NextResponse } from "next/server";
import { generateQuestionsRequestSchema } from "@/lib/schemas";
import { generateQuestionProposals } from "@/server/ai/assistant";
import { chargeAiQuota, requireAi } from "@/server/ai/guard";
import { assertOwnsQuestionSet } from "@/server/auth/ownership";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ setId: string }> };

/** Returns proposals only. Use save-proposals to store them as unreviewed, excluded questions. */
export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const { user, provider } = await requireAi(request);
  const setId = parseId((await params).setId, "Question set");
  const input = await readJson(request, generateQuestionsRequestSchema);
  const db = getDb();
  await assertOwnsQuestionSet(db, user.id, setId);
  await chargeAiQuota(db, user.id);
  const result = await generateQuestionProposals(db, provider, user.id, setId, input);
  return NextResponse.json({
    ...result,
    origin: "ai_proposed",
    evidenceStatus: "generated_unreviewed",
  });
});
