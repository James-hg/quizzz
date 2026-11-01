import "server-only";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { evidenceFor, type EvidenceState } from "@/lib/evidence";
import { anchorSchema, patchQuestionSchema } from "@/lib/schemas";
import { assertOwnsCourse } from "@/server/auth/ownership";
import { getQuestion, setQuestionStatus, updateQuestion } from "@/server/content/questions";
import type { Database } from "@/server/db";
import { addRevision } from "@/server/db/repositories/questions";
import {
  contentReviewDecisions,
  questionRevisions,
  questionRewrites,
  questionSets,
  questionSourceLinks,
  questions,
  sourceDocuments,
  sourceSegments,
} from "@/server/db/schema";
import { badRequest, conflict } from "@/server/http/errors";
import { locationOf } from "@/server/retrieval/segments";
import { failedRequired, keyConflict, type CheckResult } from "./checks";
import {
  evaluateCandidate,
  importedBaseline,
  latestChecks,
  loadOwnedRevision,
  runContentChecks,
} from "./service";

/** Revisions that need the owner's decision: generated or sample content not yet approved. */
const REVIEWABLE: readonly EvidenceState[] = ["generated_unreviewed", "needs_review"];
const NON_OWNER_ORIGINS = ["ai_proposed", "ai_variant", "sample"] as const;
export const MAX_BULK = 50;
const MAX_QUEUE = 200;

export const approveSchema = z.object({
  confirmed: z.literal(true),
  /** Required when the answer differs from the imported one. */
  keyConflictReason: z.string().trim().min(1).max(500).optional(),
});
export const rejectSchema = z.object({ confirmed: z.literal(true) });
export const citationSchema = z.object({
  segmentId: z.uuid(),
  excerpt: z.string().max(1_000).nullish(),
});
export const editSchema = z.object({
  /** `approve` is ignored: only the approve action approves. */
  patch: patchQuestionSchema,
  citations: z.array(citationSchema).max(20).optional(),
});
export const approveSelectedSchema = z.object({
  confirmed: z.literal(true),
  revisionIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_BULK)
    .refine((ids) => new Set(ids).size === ids.length, "duplicate revision ids"),
});

const names = (results: CheckResult[]) => results.map((r) => r.name);

type Reviewed = Awaited<ReturnType<typeof loadOwnedRevision>>;

/** Locks the question and makes sure the revision is still the one being decided on. */
async function lockCurrent(db: Database, userId: string, revisionId: string): Promise<Reviewed> {
  const first = await loadOwnedRevision(db, userId, revisionId);
  await db
    .select({ id: questions.id })
    .from(questions)
    .where(eq(questions.id, first.question.id))
    .for("update");
  const loaded = await loadOwnedRevision(db, userId, revisionId);
  if (loaded.question.currentRevisionId !== revisionId) {
    throw conflict(
      "This question changed since you opened it. Reload and review it again.",
      "stale_revision",
    );
  }
  return loaded;
}

/**
 * What stops this revision from being approved, or null. Looks at fresh results and also at the
 * run stored when the revision was made, so a citation that was dropped for being invalid
 * cannot make a later approval pass.
 */
async function blocker(db: Database, userId: string, loaded: Reviewed, keyConflictReason?: string) {
  const { results } = await runContentChecks(db, userId, loaded.revision.id, { persist: false });
  const stored = await latestChecks(db, loaded.revision.id);
  const failed = [...failedRequired(results), ...failedRequired(stored?.results ?? [])];
  if (failed.length > 0) {
    return conflict("Some checks failed, so this cannot be approved yet.", "checks_failed", {
      failed: [...new Set(names(failed))],
    });
  }
  if ((keyConflict(results) || keyConflict(stored?.results ?? [])) && !keyConflictReason) {
    return conflict(
      "The answer differs from the imported one. Say why you are keeping it.",
      "key_conflict_reason_required",
    );
  }
  return null;
}

function assertReviewable(loaded: Reviewed) {
  if (!REVIEWABLE.includes(loaded.revision.evidenceStatus as EvidenceState)) {
    throw conflict("This question is not waiting for review.", "not_reviewable");
  }
}

async function approveLocked(
  database: Database,
  userId: string,
  loaded: Reviewed,
  keyConflictReason: string | undefined,
) {
  const problem = await blocker(database, userId, loaded, keyConflictReason);
  if (problem) throw problem;

  const wasProposal =
    loaded.question.status === "excluded" &&
    loaded.revision.evidenceStatus === "generated_unreviewed";
  await updateQuestion(database, userId, loaded.question.id, { approve: true });
  // A generated proposal is saved excluded; approving it is what brings it back. Anything the
  // owner excluded or reported themselves stays as it is.
  if (wasProposal) await setQuestionStatus(database, userId, loaded.question.id, "active");

  const view = await getQuestion(database, userId, loaded.question.id);
  const { runId } = await runContentChecks(database, userId, view.revisionId, { persist: true });
  await database.insert(contentReviewDecisions).values({
    questionRevisionId: view.revisionId,
    checkRunId: runId,
    reviewerId: userId,
    decision: "approve",
    conflictReason: keyConflictReason ?? null,
  });
  return view;
}

/**
 * Approves the current revision. The checks are run again here, never taken from the page, and
 * the result is recorded as `human_reviewed`: the owner's decision, not a claim of verification.
 */
export async function approveRevision(
  db: Database,
  userId: string,
  revisionId: string,
  input: z.infer<typeof approveSchema>,
) {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const loaded = await lockCurrent(database, userId, revisionId);
    if (loaded.revision.evidenceStatus === "human_reviewed") {
      return getQuestion(database, userId, loaded.question.id);
    }
    assertReviewable(loaded);
    return approveLocked(database, userId, loaded, input.keyConflictReason);
  });
}

/** Rejects the content: a new rejected revision, and the question leaves practice. */
export async function rejectRevision(db: Database, userId: string, revisionId: string) {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const loaded = await lockCurrent(database, userId, revisionId);
    const { revision } = loaded;
    if (revision.evidenceStatus === "rejected")
      return getQuestion(database, userId, loaded.question.id);
    const created = await addRevision(database, loaded.question.id, {
      type: revision.type,
      prompt: revision.prompt,
      codeSnippet: revision.codeSnippet,
      explanation: revision.explanation,
      options: revision.options,
      answerKey: revision.answerKey,
      origin: revision.origin,
      evidenceStatus: evidenceFor({
        origin: revision.origin,
        answerKind: revision.answerKey.kind,
        approve: false,
        reject: true,
      }),
      createdBy: userId,
    });
    if (loaded.question.status === "active") {
      await database
        .update(questions)
        .set({ status: "excluded" })
        .where(eq(questions.id, loaded.question.id));
    }
    const { runId } = await runContentChecks(database, userId, created.id, { persist: true });
    await database.insert(contentReviewDecisions).values({
      questionRevisionId: created.id,
      checkRunId: runId,
      reviewerId: userId,
      decision: "reject",
    });
    return getQuestion(database, userId, loaded.question.id);
  });
}

/**
 * Edits the current revision (a new revision, still waiting for review) and optionally replaces
 * what it cites. Citations that do not exist or are not the owner's are not linked, and the
 * failure stays on the new revision's record so it cannot be approved until it is fixed.
 */
export async function editRevision(
  db: Database,
  userId: string,
  revisionId: string,
  input: z.infer<typeof editSchema>,
) {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const loaded = await lockCurrent(database, userId, revisionId);
    if (loaded.revision.origin === "original") {
      throw badRequest("Edit your own questions in the question editor.", "use_editor");
    }
    const view = await updateQuestion(database, userId, loaded.question.id, {
      ...input.patch,
      approve: false,
    });
    if (input.citations) {
      const baseline = await importedBaseline(database, loaded.question.id);
      const { cited } = await evaluateCandidate(
        database,
        { userId, courseId: loaded.courseId, baseline },
        {},
        input.citations,
      );
      const allowed = new Set(cited.filter((c) => c.allowed).map((c) => c.id));
      await database
        .delete(questionSourceLinks)
        .where(eq(questionSourceLinks.questionRevisionId, view.revisionId));
      const links = input.citations.filter((c) => allowed.has(c.segmentId));
      if (links.length > 0) {
        await database.insert(questionSourceLinks).values(
          links.map((c) => ({
            questionRevisionId: view.revisionId,
            sourceSegmentId: c.segmentId,
            relationship: "evidence" as const,
            excerpt: c.excerpt ?? null,
          })),
        );
      }
      await runContentChecks(database, userId, view.revisionId, {
        persist: true,
        citations: input.citations,
      });
    } else {
      await runContentChecks(database, userId, view.revisionId, { persist: true });
    }
    return getQuestion(database, userId, loaded.question.id);
  });
}

/**
 * Approves up to 50 questions of a course in one go. Every one is checked first; if any cannot
 * be approved (stale, failed checks, or a conflict that needs its own reason) nothing changes.
 */
export async function approveSelected(
  db: Database,
  userId: string,
  courseId: string,
  revisionIds: string[],
) {
  await assertOwnsCourse(db, userId, courseId);
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const loadedAll: Reviewed[] = [];
    const problems: { revisionId: string; code: string; failed?: unknown }[] = [];
    for (const id of revisionIds) {
      const loaded = await lockCurrent(database, userId, id).catch((error) => {
        problems.push({ revisionId: id, code: (error as { code?: string }).code ?? "invalid" });
        return null;
      });
      if (!loaded) continue;
      if (loaded.courseId !== courseId) {
        problems.push({ revisionId: id, code: "not_in_course" });
      } else if (!REVIEWABLE.includes(loaded.revision.evidenceStatus as EvidenceState)) {
        problems.push({ revisionId: id, code: "not_reviewable" });
      } else {
        const problem = await blocker(database, userId, loaded);
        if (problem) {
          problems.push({ revisionId: id, code: problem.code, failed: problem.details?.failed });
        } else {
          loadedAll.push(loaded);
        }
      }
    }
    if (problems.length > 0) {
      throw conflict(
        "Some questions cannot be approved together. Nothing was changed.",
        "bulk_blocked",
        { problems },
      );
    }
    const approved = [];
    for (const loaded of loadedAll)
      approved.push(await approveLocked(database, userId, loaded, undefined));
    return approved;
  });
}

export type QueueCitation = {
  segmentId: string;
  filename: string;
  location: string;
  excerpt: string | null;
};

export async function getReviewQueue(db: Database, userId: string, courseId: string) {
  await assertOwnsCourse(db, userId, courseId);
  const rows = await db
    .select({
      question: questions,
      revision: questionRevisions,
      setTitle: questionSets.title,
      setId: questionSets.id,
    })
    .from(questions)
    .innerJoin(questionRevisions, eq(questions.currentRevisionId, questionRevisions.id))
    .innerJoin(questionSets, eq(questions.questionSetId, questionSets.id))
    .where(
      and(
        eq(questionSets.courseId, courseId),
        eq(questionSets.ownerId, userId),
        inArray(questionRevisions.origin, [...NON_OWNER_ORIGINS]),
        inArray(questionRevisions.evidenceStatus, [...REVIEWABLE]),
      ),
    )
    .orderBy(asc(questionSets.title), asc(questions.position))
    .limit(MAX_QUEUE);

  const items = [];
  for (const row of rows) {
    const revision = { ...row.revision } as typeof row.revision;
    const { results } = await runContentChecks(db, userId, revision.id, { persist: false });
    const stored = await latestChecks(db, revision.id);
    const view = await getQuestion(db, userId, row.question.id);
    const links = await db
      .select({
        segmentId: sourceSegments.id,
        filename: sourceDocuments.filename,
        anchor: sourceSegments.anchor,
        excerpt: questionSourceLinks.excerpt,
      })
      .from(questionSourceLinks)
      .innerJoin(sourceSegments, eq(questionSourceLinks.sourceSegmentId, sourceSegments.id))
      .innerJoin(sourceDocuments, eq(sourceSegments.sourceDocumentId, sourceDocuments.id))
      .where(eq(questionSourceLinks.questionRevisionId, revision.id));
    const baseline = await importedBaseline(db, row.question.id, revision.id);
    const citations: QueueCitation[] = links.flatMap((l) => {
      const anchor = anchorSchema.safeParse(l.anchor);
      return anchor.success
        ? [
            {
              segmentId: l.segmentId,
              filename: l.filename,
              location: locationOf(anchor.data),
              excerpt: l.excerpt,
            },
          ]
        : [];
    });
    const storedFailures = failedRequired(stored?.results ?? []);
    items.push({
      kind: "question" as const,
      setId: row.setId,
      setTitle: row.setTitle,
      question: view,
      checks: results,
      // Failures recorded when the revision was made stay visible and still block approval.
      recordedFailures: storedFailures.map((f) => f.name),
      keyConflict: keyConflict(results),
      importedKey: baseline,
      citations,
    });
  }

  const rewriteRows = await db
    .select({
      rewrite: questionRewrites,
      currentRevisionId: questions.currentRevisionId,
      setId: questionSets.id,
      setTitle: questionSets.title,
    })
    .from(questionRewrites)
    .innerJoin(questions, eq(questionRewrites.questionId, questions.id))
    .innerJoin(questionSets, eq(questions.questionSetId, questionSets.id))
    .where(
      and(
        eq(questionRewrites.ownerId, userId),
        eq(questionRewrites.status, "pending"),
        eq(questionSets.courseId, courseId),
      ),
    )
    .orderBy(desc(questionRewrites.createdAt), asc(questionRewrites.id))
    .limit(MAX_QUEUE);
  const rewrites = [];
  for (const r of rewriteRows) {
    const baseline = await importedBaseline(db, r.rewrite.questionId);
    const { results } = await evaluateCandidate(
      db,
      { userId, courseId, baseline },
      r.rewrite.content as unknown as Record<string, unknown>,
      [],
    );
    rewrites.push({
      kind: "rewrite" as const,
      id: r.rewrite.id,
      questionId: r.rewrite.questionId,
      setId: r.setId,
      setTitle: r.setTitle,
      mode: r.rewrite.mode,
      content: r.rewrite.content,
      stale: r.currentRevisionId !== r.rewrite.baseRevisionId,
      checks: results,
      keyConflict: keyConflict(results),
    });
  }
  return { questions: items, rewrites };
}

/** How many things wait for review in a course, for a link badge. */
export async function countReviewQueue(db: Database, userId: string, courseId: string) {
  const [{ n: generated } = { n: 0 }] = await db
    .select({ n: count() })
    .from(questions)
    .innerJoin(questionRevisions, eq(questions.currentRevisionId, questionRevisions.id))
    .innerJoin(questionSets, eq(questions.questionSetId, questionSets.id))
    .where(
      and(
        eq(questionSets.courseId, courseId),
        eq(questionSets.ownerId, userId),
        inArray(questionRevisions.origin, [...NON_OWNER_ORIGINS]),
        inArray(questionRevisions.evidenceStatus, [...REVIEWABLE]),
      ),
    );
  const [{ n: rewrites } = { n: 0 }] = await db
    .select({ n: count() })
    .from(questionRewrites)
    .innerJoin(questions, eq(questionRewrites.questionId, questions.id))
    .innerJoin(questionSets, eq(questions.questionSetId, questionSets.id))
    .where(
      and(
        eq(questionRewrites.ownerId, userId),
        eq(questionRewrites.status, "pending"),
        eq(questionSets.courseId, courseId),
      ),
    );
  return generated + rewrites;
}
