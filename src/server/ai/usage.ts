import "server-only";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Database } from "@/server/db";
import { aiUsage } from "@/server/db/schema";
import { AiRateLimited } from "./errors";

const HOUR_MS = 60 * 60 * 1000;
const KEEP_MS = 48 * HOUR_MS;

/**
 * Counts one AI call for `userId` in the current hour and refuses once the hourly limit is
 * exceeded. The upsert is atomic, so concurrent requests cannot slip past the limit.
 */
export async function consumeAiQuota(
  db: Database,
  userId: string,
  limitPerHour: number,
  now: Date = new Date(),
): Promise<void> {
  const windowStart = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const [row] = await db
    .insert(aiUsage)
    .values({ userId, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [aiUsage.userId, aiUsage.windowStart],
      set: { count: sql`${aiUsage.count} + 1` },
    })
    .returning({ count: aiUsage.count });

  // Housekeeping for this user only; the primary key keeps it cheap.
  await db
    .delete(aiUsage)
    .where(
      and(eq(aiUsage.userId, userId), lt(aiUsage.windowStart, new Date(now.getTime() - KEEP_MS))),
    );

  if ((row?.count ?? 0) > limitPerHour) throw new AiRateLimited();
}
