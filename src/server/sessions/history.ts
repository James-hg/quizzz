import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { assertOwnsQuestionSet } from "@/server/auth/ownership";
import type { Database } from "@/server/db";
import { attempts, studySessions } from "@/server/db/schema";

/**
 * Completed sessions for a question set with counts, in one aggregate query (no per-session
 * lookups). `totalItems` is the session's item count; `answered` and `correct` come from its
 * attempts.
 */
export async function listSetHistory(db: Database, userId: string, setId: string) {
  await assertOwnsQuestionSet(db, userId, setId);
  return db
    .select({
      sessionId: studySessions.id,
      startedAt: studySessions.startedAt,
      completedAt: studySessions.completedAt,
      elapsedSeconds: studySessions.elapsedSeconds,
      totalItems: sql<number>`jsonb_array_length(${studySessions.itemOrder})::int`,
      answered: sql<number>`count(${attempts.id})::int`,
      correct: sql<number>`(count(*) filter (where ${attempts.isCorrect}))::int`,
    })
    .from(studySessions)
    .leftJoin(attempts, eq(attempts.sessionId, studySessions.id))
    .where(
      and(
        eq(studySessions.userId, userId),
        eq(studySessions.questionSetId, setId),
        eq(studySessions.state, "completed"),
      ),
    )
    .groupBy(studySessions.id)
    .orderBy(desc(studySessions.completedAt));
}
