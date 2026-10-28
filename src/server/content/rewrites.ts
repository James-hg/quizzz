import "server-only";
import { and, asc, desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { evidenceFor } from "@/lib/evidence";
import { checkProposal, rewriteModeSchema, provenanceFor, type RewriteMode } from "@/lib/rewrite";
import {
  contentToRevision,
  questionContentSchema,
  revisionToContentInput,
  type QuestionContent,
  type RevisionColumns,
} from "@/lib/schemas";
import { assertOwnsQuestion, assertOwnsQuestionSet } from "@/server/auth/ownership";
import type { Database } from "@/server/db";
import { addRevision } from "@/server/db/repositories/questions";
import { questionRewrites, questions } from "@/server/db/schema";
import { badRequest, conflict, notFound } from "@/server/http/errors";
import { getQuestion } from "./questions";

export const saveRewriteSchema = z.object({
  mode: rewriteModeSchema,
  baseRevisionId: z.uuid(),
  content: questionContentSchema,
});
export type SaveRewriteInput = z.infer<typeof saveRewriteSchema>;

export const acceptRewriteSchema = z.object({
  /** "I have checked this question and its answer." Required: accepting is the owner's review. */
  confirmed: z.literal(true, {
    error: "Confirm that you have checked the question and its answer.",
  }),
  /** Replace the question with a new revision, or add the rewrite as a separate question. */
  as: z.enum(["revision", "new_question"]).default("revision"),
});
export type AcceptRewriteInput = z.infer<typeof acceptRewriteSchema>;

export type RewriteView = {
  id: string;
  questionId: string;
  mode: RewriteMode;
  content: QuestionContent;
  origin: "ai_variant" | "ai_proposed";
  evidenceStatus: string;
  baseRevisionId: string;
  /** True when the question has changed since the proposal was made, so it cannot replace it. */
  stale: boolean;
  createdAt: Date;
};

type OwnerQuestion = Awaited<ReturnType<typeof getQuestion>>;

/** The question as editable content. A question with no answer has nothing to rewrite. */
export function contentOf(view: OwnerQuestion): QuestionContent {
  const parsed = questionContentSchema.safeParse(
    revisionToContentInput({
      type: view.type,
      prompt: view.prompt,
      codeSnippet: view.codeSnippet,
      explanation: view.explanation,
      options: view.options,
      answerKey: view.answerKey,
    } as RevisionColumns),
  );
  if (!parsed.success || view.answerKey.kind === "unresolved") {
    throw conflict("Set the correct answer before rewriting this question.", "unresolved_answer");
  }
  return parsed.data;
}

/** The owner's question, its current content, and the revision a proposal would be based on. */
export async function loadOriginal(db: Database, userId: string, questionId: string) {
  const view = await getQuestion(db, userId, questionId);
  return { view, content: contentOf(view) };
}

/**
 * Stores a proposal for the owner to review. It is checked against the question it was made from
 * (so a changed answer cannot be saved as a "rephrase") and its origin and review state come from
 * the mode, never from the client. The question itself is not changed.
 */
export async function saveRewrite(
  db: Database,
  userId: string,
  questionId: string,
  input: SaveRewriteInput,
): Promise<RewriteView> {
  const { view, content: original } = await loadOriginal(db, userId, questionId);
  if (view.revisionId !== input.baseRevisionId) {
    throw conflict(
      "This question has changed since the proposal was made. Ask for a new one.",
      "stale_proposal",
    );
  }
  const problem = checkProposal(input.mode, original, input.content);
  if (problem) throw badRequest(`This proposal is not valid: ${problem}.`, "invalid_proposal");

  const provenance = provenanceFor(input.mode);
  const [row] = await db
    .insert(questionRewrites)
    .values({
      ownerId: userId,
      questionId,
      baseRevisionId: input.baseRevisionId,
      mode: input.mode,
      content: input.content,
      ...provenance,
    })
    .returning();
  return toView(row!, view.revisionId);
}

function toView(row: typeof questionRewrites.$inferSelect, currentRevisionId: string): RewriteView {
  return {
    id: row.id,
    questionId: row.questionId,
    mode: row.mode,
    content: row.content,
    origin: row.origin as RewriteView["origin"],
    evidenceStatus: row.evidenceStatus,
    baseRevisionId: row.baseRevisionId,
    stale: row.baseRevisionId !== currentRevisionId,
    createdAt: row.createdAt,
  };
}

export async function listRewrites(db: Database, userId: string, questionId: string) {
  const question = await assertOwnsQuestion(db, userId, questionId);
  const rows = await db
    .select()
    .from(questionRewrites)
    .where(and(eq(questionRewrites.questionId, questionId), eq(questionRewrites.status, "pending")))
    .orderBy(desc(questionRewrites.createdAt), asc(questionRewrites.id));
  return rows.map((row) => toView(row, question.currentRevisionId ?? ""));
}

/** Pending proposals for every question in a set, keyed by question id (one query). */
export async function listPendingRewritesForSet(
  db: Database,
  userId: string,
  setId: string,
): Promise<Record<string, RewriteView[]>> {
  await assertOwnsQuestionSet(db, userId, setId);
  const rows = await db
    .select({ rewrite: questionRewrites, currentRevisionId: questions.currentRevisionId })
    .from(questionRewrites)
    .innerJoin(questions, eq(questionRewrites.questionId, questions.id))
    .where(
      and(
        eq(questions.questionSetId, setId),
        eq(questionRewrites.ownerId, userId),
        eq(questionRewrites.status, "pending"),
      ),
    )
    .orderBy(desc(questionRewrites.createdAt), asc(questionRewrites.id));
  const byQuestion: Record<string, RewriteView[]> = {};
  for (const { rewrite, currentRevisionId } of rows) {
    (byQuestion[rewrite.questionId] ??= []).push(toView(rewrite, currentRevisionId ?? ""));
  }
  return byQuestion;
}

async function ownedRewrite(db: Database, userId: string, rewriteId: string) {
  const [row] = await db
    .select()
    .from(questionRewrites)
    .where(and(eq(questionRewrites.id, rewriteId), eq(questionRewrites.ownerId, userId)))
    .for("update");
  if (!row) throw notFound("Proposal not found");
  return row;
}

/**
 * Accepting is the owner's review: it becomes a new revision of the question (or a separate
 * question) that counts as reviewed and can be practised. Origin stays AI-derived, so where it
 * came from is kept. A retry of an accepted proposal returns the same result.
 */
export async function acceptRewrite(
  db: Database,
  userId: string,
  rewriteId: string,
  input: AcceptRewriteInput,
) {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const row = await ownedRewrite(database, userId, rewriteId);

    if (row.status === "dismissed") {
      throw conflict("This proposal was dismissed.", "already_resolved");
    }
    if (row.status === "accepted") {
      if (!row.resultQuestionId)
        throw conflict("The question it created was deleted.", "result_deleted");
      return {
        replayed: true,
        question: await getQuestion(database, userId, row.resultQuestionId),
      };
    }

    const original = await getQuestion(database, userId, row.questionId);
    const answerKind = contentToRevision(row.content).answerKey.kind;
    let resultQuestionId = row.questionId;
    let revisionId: string;

    if (input.as === "revision") {
      if (original.revisionId !== row.baseRevisionId) {
        throw conflict(
          "This question has changed since the proposal was made. Dismiss it and ask for a new one.",
          "stale_proposal",
        );
      }
      const revision = await addRevision(database, row.questionId, {
        ...contentToRevision(row.content),
        origin: row.origin,
        evidenceStatus: evidenceFor({
          origin: row.origin,
          answerKind,
          approve: true,
          previous: original.evidenceStatus as Parameters<typeof evidenceFor>[0]["previous"],
        }),
        createdBy: userId,
      });
      revisionId = revision.id;
    } else {
      const [last] = await database
        .select({ p: max(questions.position) })
        .from(questions)
        .where(eq(questions.questionSetId, original.questionSetId));
      const [created] = await database
        .insert(questions)
        .values({ questionSetId: original.questionSetId, position: (last?.p ?? -1) + 1 })
        .returning();
      const revision = await addRevision(database, created!.id, {
        ...contentToRevision(row.content),
        origin: row.origin,
        evidenceStatus: evidenceFor({ origin: row.origin, answerKind, approve: true }),
        createdBy: userId,
      });
      resultQuestionId = created!.id;
      revisionId = revision.id;
    }

    await database
      .update(questionRewrites)
      .set({
        status: "accepted",
        resolvedAt: new Date(),
        resultQuestionId,
        resultRevisionId: revisionId,
      })
      .where(eq(questionRewrites.id, rewriteId));
    return { replayed: false, question: await getQuestion(database, userId, resultQuestionId) };
  });
}

export async function dismissRewrite(db: Database, userId: string, rewriteId: string) {
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const row = await ownedRewrite(database, userId, rewriteId);
    if (row.status === "accepted") {
      throw conflict("This proposal was already accepted.", "already_resolved");
    }
    if (row.status === "dismissed") return;
    await database
      .update(questionRewrites)
      .set({ status: "dismissed", resolvedAt: new Date() })
      .where(eq(questionRewrites.id, rewriteId));
  });
}
