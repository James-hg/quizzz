import { NextResponse } from "next/server";
import { submitAnswerSchema } from "@/lib/schemas";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId, readJson } from "@/server/http/request";
import { submitAnswer } from "@/server/sessions/answers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

/** The server grades. Retrying with the same idempotencyKey returns the stored result. */
export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const id = parseId((await params).sessionId, "Session");
  const input = await readJson(request, submitAnswerSchema);
  const outcome = await submitAnswer(getDb(), user.id, id, input);
  return NextResponse.json(outcome, { status: outcome.replayed ? 200 : 201 });
});
