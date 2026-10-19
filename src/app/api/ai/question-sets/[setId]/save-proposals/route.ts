import { NextResponse } from "next/server";
import { saveProposalsSchema } from "@/lib/schemas";
import { saveProposals } from "@/server/ai/proposals";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ setId: string }> };

/** Stores proposals as excluded, AI-proposed, unreviewed questions. Needs no AI call. */
export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const setId = parseId((await params).setId, "Question set");
  const { proposals } = await readJson(request, saveProposalsSchema);
  const questions = await saveProposals(getDb(), user.id, setId, proposals);
  return NextResponse.json({ questions }, { status: 201 });
});
