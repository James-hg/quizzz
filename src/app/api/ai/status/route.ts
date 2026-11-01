import { NextResponse } from "next/server";
import { getAiProvider } from "@/server/ai";
import { DisabledProvider } from "@/server/ai/disabled";
import { readPausedUntil } from "@/server/ai/usage";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute } from "@/server/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether AI help is usable on this server right now. It says nothing about one person's own
 * limits, spends no quota, and never calls the provider. Practice does not depend on it.
 */
export const GET = handleRoute(async (request: Request) => {
  await requireUser(request);
  const headers = { "Cache-Control": "private, no-store" };
  const provider = getAiProvider();
  if (provider instanceof DisabledProvider) {
    return NextResponse.json({ state: "disabled", message: provider.reason }, { headers });
  }
  const pausedUntil = await readPausedUntil(getDb());
  if (pausedUntil && pausedUntil > new Date()) {
    return NextResponse.json(
      {
        state: "paused",
        retryAt: pausedUntil.toISOString(),
        message:
          "AI help is paused because the AI service is out of quota. Practice still works. It will be tried again later.",
      },
      { headers },
    );
  }
  return NextResponse.json({ state: "available", message: "AI help is available." }, { headers });
});
