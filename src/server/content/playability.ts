import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import { countPlayability, emptyCounts, type PlayabilityCounts } from "@/lib/playability";
import type { Database } from "@/server/db";
import { questionRevisions, questions } from "@/server/db/schema";

/** How many questions of each set can be practised, and why the others cannot. */
export async function playabilityBySet(
  db: Database,
  setIds: string[],
): Promise<Map<string, PlayabilityCounts>> {
  const result = new Map<string, PlayabilityCounts>(setIds.map((id) => [id, emptyCounts()]));
  if (setIds.length === 0) return result;

  const rows = await db
    .select({
      setId: questions.questionSetId,
      status: questions.status,
      evidenceStatus: questionRevisions.evidenceStatus,
      answerKind: sql<string>`${questionRevisions.answerKey}->>'kind'`,
    })
    .from(questions)
    .innerJoin(questionRevisions, eq(questions.currentRevisionId, questionRevisions.id))
    .where(inArray(questions.questionSetId, setIds));

  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.setId, [...(grouped.get(row.setId) ?? []), row]);
  for (const [setId, items] of grouped) result.set(setId, countPlayability(items));
  return result;
}

export async function playabilityForSet(db: Database, setId: string): Promise<PlayabilityCounts> {
  return (await playabilityBySet(db, [setId])).get(setId) ?? emptyCounts();
}
