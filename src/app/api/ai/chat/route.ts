import { NextResponse } from "next/server";
import { chatRequestSchema } from "@/lib/schemas";
import { chat } from "@/server/ai/assistant";
import { requireAi, withAiOperation } from "@/server/ai/guard";
import { assertOwnsCourse, assertOwnsQuestionSet } from "@/server/auth/ownership";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handleRoute(async (request: Request) => {
  const { user, provider } = await requireAi(request);
  const input = await readJson(request, chatRequestSchema);
  const db = getDb();
  if (input.questionSetId) await assertOwnsQuestionSet(db, user.id, input.questionSetId);
  if (input.courseId) await assertOwnsCourse(db, user.id, input.courseId);
  const reply = await withAiOperation(db, { userId: user.id, route: "chat" }, provider, (metered) =>
    chat(db, metered, user.id, input),
  );
  return NextResponse.json({ reply });
});
