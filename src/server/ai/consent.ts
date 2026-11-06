import "server-only";
import { and, eq } from "drizzle-orm";
import { AI_NOTICE, AI_NOTICE_VERSION, type AiConsentStatus } from "@/lib/ai-consent";
import type { Database } from "@/server/db";
import { aiConsents } from "@/server/db/schema";

export async function hasCurrentAiConsent(db: Database, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: aiConsents.userId })
    .from(aiConsents)
    .where(and(eq(aiConsents.userId, userId), eq(aiConsents.noticeVersion, AI_NOTICE_VERSION)));
  return row !== undefined;
}

/** Records acceptance of the current notice. Repeating it keeps the first acceptance time. */
export async function acceptCurrentAiConsent(db: Database, userId: string): Promise<void> {
  await db
    .insert(aiConsents)
    .values({ userId, noticeVersion: AI_NOTICE_VERSION })
    .onConflictDoNothing();
}

export async function aiConsentStatus(db: Database, userId: string): Promise<AiConsentStatus> {
  return {
    noticeVersion: AI_NOTICE_VERSION,
    accepted: await hasCurrentAiConsent(db, userId),
    notice: AI_NOTICE,
  };
}
