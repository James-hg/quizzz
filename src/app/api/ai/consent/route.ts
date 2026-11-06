import { NextResponse } from "next/server";
import { acceptConsentSchema, AI_NOTICE_VERSION } from "@/lib/ai-consent";
import { acceptCurrentAiConsent, aiConsentStatus } from "@/server/ai/consent";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { conflict, handleRoute } from "@/server/http/errors";
import { readJson } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store" };

/** The current notice and whether the signed-in user has accepted it. Never calls a model. */
export const GET = handleRoute(async (request: Request) => {
  const user = await requireUser(request);
  return NextResponse.json(await aiConsentStatus(getDb(), user.id), { headers });
});

/**
 * Accepts the current notice. The body must name the version the user was shown, so accepting an
 * old page cannot record consent to wording they did not see. The server sets user and time.
 */
export const POST = handleRoute(async (request: Request) => {
  const user = await requireUser(request);
  const input = await readJson(request, acceptConsentSchema);
  if (input.noticeVersion !== AI_NOTICE_VERSION) {
    throw conflict(
      "The AI notice has changed. Read the new version and accept it again.",
      "notice_version_changed",
      { noticeVersion: AI_NOTICE_VERSION },
    );
  }
  const db = getDb();
  await acceptCurrentAiConsent(db, user.id);
  return NextResponse.json(await aiConsentStatus(db, user.id), { headers });
});
