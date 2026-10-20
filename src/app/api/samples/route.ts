import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { handleRoute } from "@/server/http/errors";
import { listAvailableSamples } from "@/server/samples/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sample courses that can be copied into the user's account. Empty when none exist. */
export const GET = handleRoute(async (request: Request) => {
  await requireUser(request);
  return NextResponse.json({ samples: await listAvailableSamples() });
});
