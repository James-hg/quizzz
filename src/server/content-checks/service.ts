import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { revisionToContentInput, type RevisionColumns } from "@/lib/schemas";
import type { Database } from "@/server/db";
import { parseRevisionJson } from "@/server/db/repositories/questions";
import {
  contentChecks,
  questionRevisions,
  questionSets,
  questionSourceLinks,
  questions,
  sourceDocuments,
  sourceSegments,
} from "@/server/db/schema";
import { notFound } from "@/server/http/errors";
import {
  checkCorrectOptionCount,
  checkExcerptFidelity,
  checkExplanationAgreement,
  checkImportedKey,
  checkSchema,
  checkSourceIds,
  checkSupportedType,
  VALIDATOR_VERSION,
  type CheckName,
  type CheckResult,
  type CitedSegment,
  type KeyShape,
} from "./checks";
import type { QuestionContent } from "@/lib/schemas";

export type Citation = { segmentId: string; excerpt?: string | null };

export type CheckContext = {
  userId: string;
  courseId: string;
  /** The answer the question had when imported, if it was imported and had one. */
  baseline: KeyShape | null;
};

/** Looks at content and citations without storing anything. */
export async function evaluateCandidate(
  db: Database,
  ctx: CheckContext,
  content: Record<string, unknown>,
  citations: Citation[],
): Promise<{ results: CheckResult[]; cited: CitedSegment[] }> {
  const ids = [...new Set(citations.map((c) => c.segmentId))];
  const rows = ids.length
    ? await db
        .select({
          id: sourceSegments.id,
          text: sourceSegments.text,
          ownerId: sourceDocuments.ownerId,
          courseId: sourceDocuments.courseId,
        })
        .from(sourceSegments)
        .innerJoin(sourceDocuments, eq(sourceSegments.sourceDocumentId, sourceDocuments.id))
        .where(inArray(sourceSegments.id, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const cited: CitedSegment[] = citations.flatMap((c) => {
    const row = byId.get(c.segmentId);
    return row
      ? [
          {
            id: row.id,
            text: row.text,
            allowed: row.ownerId === ctx.userId && row.courseId === ctx.courseId,
            excerpt: c.excerpt ?? null,
          },
        ]
      : [];
  });

  const schema = checkSchema(content);
  const valid = schema.result === "pass";
  const shaped = content as {
    type: string;
    options?: { id: string }[];
    correctOptionIds?: string[];
  };
  const results: CheckResult[] = [
    schema,
    checkSupportedType(content.type),
    checkCorrectOptionCount(shaped),
    checkSourceIds(ids, cited),
    checkExcerptFidelity(cited),
    // The next two read the answer, so they only make sense for content that is well formed.
    valid
      ? checkExplanationAgreement(content as QuestionContent)
      : { name: "explanation_answer_agreement", result: "not_applicable", reasonCode: "invalid" },
    checkImportedKey(ctx.baseline, keyOf(content)),
  ];
  return { results, cited };
}

/** The answer key a piece of editor content implies. */
export function keyOf(content: Record<string, unknown>): KeyShape {
  const c = content as {
    correctOptionIds?: string[];
    accepted?: string[];
    blanks?: string[][];
    caseSensitive?: boolean;
  };
  if (c.correctOptionIds) return { kind: "options", correctOptionIds: c.correctOptionIds };
  if (c.accepted) {
    return { kind: "text", accepted: c.accepted, caseSensitive: Boolean(c.caseSensitive) };
  }
  if (c.blanks)
    return { kind: "blanks", blanks: c.blanks, caseSensitive: Boolean(c.caseSensitive) };
  return { kind: "unresolved" };
}

/**
 * The answer an imported question was first given. Only imported sets have one; a question the
 * owner wrote, or generated content, has no original to compare with.
 */
export async function importedBaseline(
  db: Database,
  questionId: string,
  excludeRevisionId?: string,
): Promise<KeyShape | null> {
  const [set] = await db
    .select({ origin: questionSets.origin })
    .from(questions)
    .innerJoin(questionSets, eq(questions.questionSetId, questionSets.id))
    .where(eq(questions.id, questionId));
  if (set?.origin !== "imported") return null;
  const [first] = await db
    .select({ answerKey: questionRevisions.answerKey })
    .from(questionRevisions)
    .where(
      and(
        eq(questionRevisions.questionId, questionId),
        sql`${questionRevisions.answerKey}->>'kind' <> 'unresolved'`,
        excludeRevisionId ? ne(questionRevisions.id, excludeRevisionId) : undefined,
      ),
    )
    .orderBy(asc(questionRevisions.revisionNumber))
    .limit(1);
  return first ? (first.answerKey as KeyShape) : null;
}

export type StoredRun = { runId: string; validatorVersion: string; results: CheckResult[] };

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The most recent complete run for a revision, if any. */
export async function latestChecks(db: Database, revisionId: string): Promise<StoredRun | null> {
  const [newest] = await db
    .select({ runId: contentChecks.runId })
    .from(contentChecks)
    .where(eq(contentChecks.questionRevisionId, revisionId))
    .orderBy(desc(contentChecks.createdAt))
    .limit(1);
  if (!newest) return null;
  const rows = await db.select().from(contentChecks).where(eq(contentChecks.runId, newest.runId));
  return {
    runId: newest.runId,
    validatorVersion: rows[0]!.validatorVersion,
    results: rows.map((r) => ({
      name: r.checkName as CheckName,
      result: r.result as CheckResult["result"],
      reasonCode: (r.details as { reasonCode?: string }).reasonCode,
      details: r.details as Record<string, unknown>,
    })),
  };
}

type LoadedRevision = {
  revision: typeof questionRevisions.$inferSelect;
  question: typeof questions.$inferSelect;
  courseId: string;
  setOrigin: string;
};

/** A revision of one of the user's own questions. Others get the same 404 as a missing one. */
export async function loadOwnedRevision(
  db: Database,
  userId: string,
  revisionId: string,
): Promise<LoadedRevision> {
  const [row] = await db
    .select({
      revision: questionRevisions,
      question: questions,
      courseId: questionSets.courseId,
      setOrigin: questionSets.origin,
    })
    .from(questionRevisions)
    .innerJoin(questions, eq(questionRevisions.questionId, questions.id))
    .innerJoin(questionSets, eq(questions.questionSetId, questionSets.id))
    .where(and(eq(questionRevisions.id, revisionId), eq(questionSets.ownerId, userId)));
  if (!row) throw notFound("Question not found");
  return { ...row, revision: parseRevisionJson(row.revision) };
}

/** Citations stored on a revision. */
export async function linkedCitations(db: Database, revisionId: string): Promise<Citation[]> {
  const rows = await db
    .select({
      segmentId: questionSourceLinks.sourceSegmentId,
      excerpt: questionSourceLinks.excerpt,
    })
    .from(questionSourceLinks)
    .where(eq(questionSourceLinks.questionRevisionId, revisionId));
  return rows;
}

/**
 * Checks a stored revision against its own links. With `persist`, the run is added to the audit
 * table, unless the same revision, links, sources and validator already have a run.
 */
export async function runContentChecks(
  db: Database,
  userId: string,
  revisionId: string,
  options: { persist: boolean; citations?: Citation[] },
): Promise<{ runId: string | null; results: CheckResult[] }> {
  const loaded = await loadOwnedRevision(db, userId, revisionId);
  const content = revisionToContentInput(loaded.revision as unknown as RevisionColumns);
  // Citations a request asked for but that could not be linked still count against the revision.
  const citations = options.citations ?? (await linkedCitations(db, revisionId));
  const baseline = await importedBaseline(db, loaded.question.id, revisionId);
  const { results, cited } = await evaluateCandidate(
    db,
    { userId, courseId: loaded.courseId, baseline },
    content,
    citations,
  );
  if (!options.persist) return { runId: null, results };

  const inputHash = sha({
    content,
    citations: citations.map((c) => [c.segmentId, c.excerpt ?? null]).sort(),
    sources: cited.map((c) => [c.id, sha(c.text), c.allowed]).sort(),
    baseline,
  });
  const previous = await latestChecks(db, revisionId);
  if (previous && previous.validatorVersion === VALIDATOR_VERSION) {
    const [row] = await db
      .select({ inputHash: contentChecks.inputHash })
      .from(contentChecks)
      .where(eq(contentChecks.runId, previous.runId))
      .limit(1);
    if (row?.inputHash === inputHash) return { runId: previous.runId, results: previous.results };
  }
  const runId = randomUUID();
  await db.insert(contentChecks).values(
    results.map((r) => ({
      questionRevisionId: revisionId,
      runId,
      checkName: r.name,
      result: r.result,
      validatorVersion: VALIDATOR_VERSION,
      inputHash,
      details: { ...(r.details ?? {}), ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}) },
    })),
  );
  return { runId, results };
}
