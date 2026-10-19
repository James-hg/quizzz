import "server-only";
import type { SessionUser } from "@/server/auth/session";
import { requireUser } from "@/server/auth/session";
import type { Database } from "@/server/db";
import { getEnv } from "@/server/env";
import { DisabledProvider } from "./disabled";
import { AiUnavailable } from "./errors";
import { getAiProvider } from "./index";
import type { AiProvider } from "./provider";
import { consumeAiQuota } from "./usage";

/**
 * First step of every AI route: sign-in required (401), then a clear 503 when AI is off, so
 * nothing else (validation, quota, database work) happens for an unavailable feature.
 */
export async function requireAi(
  request: Request,
): Promise<{ user: SessionUser; provider: AiProvider }> {
  const user = await requireUser(request);
  const provider = getAiProvider();
  if (provider instanceof DisabledProvider) throw new AiUnavailable(provider.reason);
  return { user, provider };
}

/** Call after validation and ownership checks, immediately before the model call. */
export function chargeAiQuota(db: Database, userId: string) {
  return consumeAiQuota(db, userId, getEnv().AI_REQUESTS_PER_HOUR);
}
