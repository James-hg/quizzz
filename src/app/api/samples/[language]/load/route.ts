import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";
import { loadSample } from "@/server/samples/loader";
import { getSampleOrThrow } from "@/server/samples/service";
import { getStorage } from "@/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ language: string }> };

/**
 * "Explore a sample course": copies the sample into the caller's account. Calling it again
 * returns the same copy (200) instead of creating another.
 */
export const POST = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const sample = await getSampleOrThrow((await params).language);
  const result = await loadSample(getDb(), getStorage(), user.id, sample);
  return NextResponse.json(result, { status: result.alreadyLoaded ? 200 : 201 });
});
