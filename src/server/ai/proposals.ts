import "server-only";
import { eq, max } from "drizzle-orm";
import { contentToRevision, type QuestionContent } from "@/lib/schemas";
import { assertOwnsQuestionSet } from "@/server/auth/ownership";
import { toOwnerView } from "@/server/content/questions";
import type { Database } from "@/server/db";
import { addRevision } from "@/server/db/repositories/questions";
import { questions } from "@/server/db/schema";

/**
 * Stores AI proposals as excluded, unreviewed questions. They never appear in scored practice
 * until the owner approves (PATCH with approve: true) and restores them.
 */
export async function saveProposals(
  db: Database,
  userId: string,
  setId: string,
  proposals: QuestionContent[],
) {
  await assertOwnsQuestionSet(db, userId, setId);
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const [last] = await database
      .select({ p: max(questions.position) })
      .from(questions)
      .where(eq(questions.questionSetId, setId));
    let position = (last?.p ?? -1) + 1;
    const saved = [];
    for (const content of proposals) {
      const [question] = await database
        .insert(questions)
        .values({ questionSetId: setId, position: position++, status: "excluded" })
        .returning();
      const revision = await addRevision(database, question!.id, {
        ...contentToRevision(content),
        origin: "ai_proposed",
        evidenceStatus: "generated_unreviewed",
        createdBy: userId,
      });
      saved.push(toOwnerView({ ...question!, currentRevisionId: revision.id }, revision));
    }
    return saved;
  });
}
