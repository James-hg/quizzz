import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { parseId } from "@/server/http/request";
import { getOwnedSegment } from "@/server/retrieval/segments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ segmentId: string }> };

/**
 * Opens one cited passage: its exact stored text, the document it came from, and where in that
 * document it sits. Only the owner can read it; anyone else gets the same 404 as for a missing id.
 */
export const GET = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const segmentId = parseId((await params).segmentId, "Passage");
  const segment = await getOwnedSegment(getDb(), user.id, segmentId);
  return NextResponse.json({ segment }, { headers: { "Cache-Control": "private, no-store" } });
});
