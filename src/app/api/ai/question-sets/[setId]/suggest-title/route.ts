import { NextResponse } from "next/server";
import { suggestTitle } from "@/server/ai/assistant";
import { chargeAiQuota, requireAi } from "@/server/ai/guard";
import { assertOwnsQuestionSet } from "@/server/auth/ownership";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ setId: string }> };

export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const { user, provider } = await requireAi(request);
  const setId = parseId((await params).setId, "Question set");
  const db = getDb();
  await assertOwnsQuestionSet(db, user.id, setId);
  await chargeAiQuota(db, user.id);
  return NextResponse.json({ title: await suggestTitle(db, provider, user.id, setId) });
});
