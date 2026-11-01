import "server-only";
import { eq, inArray } from "drizzle-orm";
import { evidenceFor } from "@/lib/evidence";
import type { Database } from "@/server/db";
import { addRevision } from "@/server/db/repositories/questions";
import { questionRevisions, questionSets, questions } from "@/server/db/schema";
import { failedRequired } from "./checks";
import { runContentChecks } from "./service";

const APPROVED = ["human_reviewed", "source_linked", "deterministically_checked"];

export type BackfillReport = {
  checked: number;
  /** Already approved, but a required check fails now. */
  failing: { questionId: string; revisionId: string; failed: string[] }[];
  /** Of those, how many were sent back to review (only when `apply` is true). */
  quarantined: number;
};

/**
 * Runs the checks on every generated or sample question that has none recorded yet, and sends
 * approved ones that fail back to review. Safe to repeat: a revision with an unchanged record is
 * not checked again, and a question already waiting for review is left alone. It never approves,
 * relabels as verified, or touches attempts. Without `apply` it only reports.
 */
export async function backfillContentChecks(
  db: Database,
  options: { apply: boolean },
): Promise<BackfillReport> {
  const rows = await db
    .select({
      questionId: questions.id,
      status: questions.status,
      revisionId: questionRevisions.id,
      origin: questionRevisions.origin,
      evidence: questionRevisions.evidenceStatus,
      ownerId: questionSets.ownerId,
    })
    .from(questions)
    .innerJoin(questionRevisions, eq(questions.currentRevisionId, questionRevisions.id))
    .innerJoin(questionSets, eq(questions.questionSetId, questionSets.id))
    .where(inArray(questionRevisions.origin, ["ai_proposed", "ai_variant", "sample"]));

  const report: BackfillReport = { checked: 0, failing: [], quarantined: 0 };
  for (const row of rows) {
    const { results } = await runContentChecks(db, row.ownerId, row.revisionId, {
      persist: options.apply,
    });
    report.checked += 1;
    const failed = failedRequired(results);
    if (failed.length === 0 || !APPROVED.includes(row.evidence)) continue;
    report.failing.push({
      questionId: row.questionId,
      revisionId: row.revisionId,
      failed: failed.map((f) => f.name),
    });
    if (!options.apply) continue;

    await db.transaction(async (tx) => {
      const database = tx as unknown as Database;
      const [revision] = await database
        .select()
        .from(questionRevisions)
        .where(eq(questionRevisions.id, row.revisionId));
      const created = await addRevision(database, row.questionId, {
        type: revision!.type,
        prompt: revision!.prompt,
        codeSnippet: revision!.codeSnippet,
        explanation: revision!.explanation,
        options: revision!.options,
        answerKey: revision!.answerKey,
        origin: revision!.origin,
        evidenceStatus: evidenceFor({
          origin: revision!.origin,
          answerKind: revision!.answerKey.kind,
          approve: false,
        }),
        createdBy: null,
      });
      if (row.status === "active") {
        await database
          .update(questions)
          .set({ status: "excluded" })
          .where(eq(questions.id, row.questionId));
      }
      await runContentChecks(database, row.ownerId, created.id, { persist: true });
    });
    report.quarantined += 1;
  }
  return report;
}
