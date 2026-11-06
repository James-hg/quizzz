import { acceptCurrentAiConsent } from "@/server/ai/consent";
import type { Database } from "@/server/db";
import { aiCallLeases, aiCallLogs, aiProviderState, aiRateWindows } from "@/server/db/schema";

/** Clears the AI limit tables. They hold app-wide state, so tests start from a clean slate. */
export async function resetAiState(db: Database): Promise<void> {
  await db.delete(aiCallLeases);
  await db.delete(aiCallLogs);
  await db.delete(aiRateWindows);
  await db.delete(aiProviderState);
}

/** Records acceptance of the current AI notice, as the app does when the user clicks Accept. */
export async function grantAiConsent(db: Database, ...userIds: string[]): Promise<void> {
  for (const userId of userIds) await acceptCurrentAiConsent(db, userId);
}
