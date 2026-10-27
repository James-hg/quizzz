import "server-only";
import { and, asc, eq, max, notInArray, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  contentToRevision,
  patchQuestionSchema,
  questionContentSchema,
  revisionToContentInput,
  type QuestionContent,
  type RevisionColumns,
} from "@/lib/schemas";
import { assertOwnsQuestion, assertOwnsQuestionSet } from "@/server/auth/ownership";
import type { Database } from "@/server/db";
import { addRevision, parseRevisionJson } from "@/server/db/repositories/questions";
import { attempts, questionRevisions, questionSourceLinks, questions } from "@/server/db/schema";
import { badRequest, conflict, notFound } from "@/server/http/errors";
import {
  deleteUnlinkedImages,
  getOwnedImage,
  imageIdsOfRevisions,
  loadImagesForRevisions,
} from "@/server/images/service";
import { getStorage } from "@/server/storage";
import { hasHistoryError } from "./history";
import { evidenceFor } from "@/lib/evidence";
import type { QuestionImageInput, QuestionImageView } from "@/lib/images";
import { NO_ANSWER_KIND, PLAY_BLOCKING_EVIDENCE } from "@/lib/playability";

type QuestionRow = typeof questions.$inferSelect;
type RevisionRow = typeof questionRevisions.$inferSelect;

/** Owner-facing shape: includes the answer key because the editor needs it. */
export function toOwnerView(
  question: QuestionRow,
  revision: RevisionRow,
  image: QuestionImageView | null = null,
) {
  return {
    id: question.id,
    questionSetId: question.questionSetId,
    position: question.position,
    status: question.status,
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    type: revision.type,
    prompt: revision.prompt,
    codeSnippet: revision.codeSnippet,
    options: revision.options,
    answerKey: revision.answerKey,
    explanation: revision.explanation,
    origin: revision.origin,
    evidenceStatus: revision.evidenceStatus,
    image,
    createdAt: revision.createdAt,
  };
}

async function currentRevision(db: Database, question: QuestionRow): Promise<RevisionRow> {
  if (!question.currentRevisionId) throw notFound("Question has no revision");
  const [row] = await db
    .select()
    .from(questionRevisions)
    .where(eq(questionRevisions.id, question.currentRevisionId));
  if (!row) throw notFound("Question has no revision");
  return parseRevisionJson(row);
}

export async function createQuestion(
  db: Database,
  userId: string,
  setId: string,
  content: QuestionContent,
  approve: boolean,
  image?: QuestionImageInput,
) {
  await assertOwnsQuestionSet(db, userId, setId);
  if (image) await getOwnedImage(db, userId, image.imageId);
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const [last] = await database
      .select({ p: max(questions.position) })
      .from(questions)
      .where(eq(questions.questionSetId, setId));
    const [question] = await database
      .insert(questions)
      .values({ questionSetId: setId, position: (last?.p ?? -1) + 1 })
      .returning();
    const revision = await addRevision(
      database,
      question!.id,
      {
        ...contentToRevision(content),
        origin: "original",
        // The owner wrote it and it has an answer, so it counts as reviewed. `approve` only
        // matters for questions that did not originate with the owner.
        evidenceStatus: evidenceFor({
          origin: "original",
          answerKind: contentToRevision(content).answerKey.kind,
          approve,
        }),
        createdBy: userId,
      },
      { image },
    );
    const images = await loadImagesForRevisions(database, [revision.id]);
    return toOwnerView(
      { ...question!, currentRevisionId: revision.id },
      revision,
      images.get(revision.id),
    );
  });
}

export async function listQuestions(db: Database, userId: string, setId: string) {
  await assertOwnsQuestionSet(db, userId, setId);
  const rows = await db
    .select({ question: questions, revision: questionRevisions })
    .from(questions)
    .innerJoin(questionRevisions, eq(questions.currentRevisionId, questionRevisions.id))
    .where(eq(questions.questionSetId, setId))
    .orderBy(asc(questions.position));
  const images = await loadImagesForRevisions(
    db,
    rows.map((r) => r.revision.id),
  );
  return rows.map((r) =>
    toOwnerView(r.question, parseRevisionJson(r.revision), images.get(r.revision.id)),
  );
}

export async function getQuestion(db: Database, userId: string, questionId: string) {
  const question = await assertOwnsQuestion(db, userId, questionId);
  const revision = await currentRevision(db, question);
  const images = await loadImagesForRevisions(db, [revision.id]);
  return toOwnerView(question, revision, images.get(revision.id));
}

export async function listRevisions(db: Database, userId: string, questionId: string) {
  await assertOwnsQuestion(db, userId, questionId);
  const rows = await db
    .select()
    .from(questionRevisions)
    .where(eq(questionRevisions.questionId, questionId))
    .orderBy(asc(questionRevisions.revisionNumber));
  return rows.map(parseRevisionJson);
}

/**
 * Applies a partial edit by merging over the current revision, re-validating the whole
 * question, and appending revision N+1. The old revision and its attempts are untouched.
 */
export async function updateQuestion(
  db: Database,
  userId: string,
  questionId: string,
  patch: z.infer<typeof patchQuestionSchema>,
) {
  const question = await assertOwnsQuestion(db, userId, questionId);
  const current = await currentRevision(db, question);
  const { approve = false, image, ...fields } = patch;
  if (image) await getOwnedImage(db, userId, image.imageId);
  const merged = questionContentSchema.parse({
    ...revisionToContentInput(current as unknown as RevisionColumns),
    ...fields,
  });
  const revision = await addRevision(
    db,
    questionId,
    {
      ...contentToRevision(merged),
      // Editing never launders provenance: the origin is kept, and a revision that came from AI
      // or a sample stays unreviewed until the owner explicitly approves it.
      origin: current.origin,
      evidenceStatus: evidenceFor({
        origin: current.origin,
        answerKind: contentToRevision(merged).answerKey.kind,
        approve,
        previous: current.evidenceStatus,
      }),
      createdBy: userId,
    },
    { image },
  );
  const images = await loadImagesForRevisions(db, [revision.id]);
  return toOwnerView(
    { ...question, currentRevisionId: revision.id },
    revision,
    images.get(revision.id),
  );
}

export async function setQuestionStatus(
  db: Database,
  userId: string,
  questionId: string,
  status: "active" | "excluded",
) {
  const question = await assertOwnsQuestion(db, userId, questionId);
  if (question.status === "reported" && status === "active") {
    throw conflict("Reported questions are restored through review", "reported");
  }
  if (status === "active") {
    const revision = await currentRevision(db, question);
    if (revision.answerKey.kind === "unresolved") {
      throw conflict("Set the correct answer before restoring this question", "unresolved_answer");
    }
    if ((PLAY_BLOCKING_EVIDENCE as readonly string[]).includes(revision.evidenceStatus)) {
      throw conflict(
        revision.evidenceStatus === "rejected"
          ? "This question was rejected. Edit and approve it before including it in practice."
          : "Review and approve this question first",
        "needs_review",
      );
    }
  }
  const [row] = await db
    .update(questions)
    .set({ status })
    .where(eq(questions.id, questionId))
    .returning();
  const revision = await currentRevision(db, row!);
  const images = await loadImagesForRevisions(db, [revision.id]);
  return toOwnerView(row!, revision, images.get(revision.id));
}

/** Hard delete only for never-attempted questions; otherwise 409 has_history. */
export async function deleteQuestion(db: Database, userId: string, questionId: string) {
  await assertOwnsQuestion(db, userId, questionId);
  const [attempted] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(eq(attempts.questionId, questionId))
    .limit(1);
  if (attempted) throw hasHistoryError();
  let imageIds: string[] = [];
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const revisions = await database
      .select({ id: questionRevisions.id })
      .from(questionRevisions)
      .where(eq(questionRevisions.questionId, questionId));
    imageIds = await imageIdsOfRevisions(
      database,
      revisions.map((r) => r.id),
    );
    await database
      .update(questions)
      .set({ currentRevisionId: null })
      .where(eq(questions.id, questionId));
    for (const r of revisions) {
      await database
        .delete(questionSourceLinks)
        .where(eq(questionSourceLinks.questionRevisionId, r.id));
    }
    await database.delete(questionRevisions).where(eq(questionRevisions.questionId, questionId));
    await database.delete(questions).where(eq(questions.id, questionId));
  });
  // The question's images go with it, unless another question still shows them.
  await deleteUnlinkedImages(db, getStorage(), imageIds);
}

/** `questionIds` must be exactly the set's questions; positions become 0..n-1 in that order. */
export async function reorderQuestions(
  db: Database,
  userId: string,
  setId: string,
  questionIds: string[],
) {
  await assertOwnsQuestionSet(db, userId, setId);
  const existing = await db
    .select({ id: questions.id })
    .from(questions)
    .where(eq(questions.questionSetId, setId));
  const same =
    existing.length === questionIds.length &&
    new Set(questionIds).size === questionIds.length &&
    existing.every((q) => questionIds.includes(q.id));
  if (!same) throw badRequest("questionIds must list every question in the set exactly once");
  await db.transaction(async (tx) => {
    for (const [index, id] of questionIds.entries()) {
      await tx
        .update(questions)
        .set({ position: index })
        .where(and(eq(questions.id, id), eq(questions.questionSetId, setId)));
    }
  });
  return listQuestions(db, userId, setId);
}

/** Fisher-Yates with an injectable RNG so tests are deterministic. */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** Stores a new option order as a new revision, so the order is fixed rather than per-request. */
export async function shuffleOptions(
  db: Database,
  userId: string,
  questionId: string,
  random?: () => number,
) {
  const question = await assertOwnsQuestion(db, userId, questionId);
  const current = await currentRevision(db, question);
  if (current.type !== "mcq_single" && current.type !== "mcq_multi") {
    throw badRequest("Only multiple-choice questions have options to shuffle");
  }
  const revision = await addRevision(db, questionId, {
    type: current.type,
    prompt: current.prompt,
    codeSnippet: current.codeSnippet,
    explanation: current.explanation,
    options: shuffled(current.options, random),
    answerKey: current.answerKey,
    // Shuffling changes order only: it must not change where the question came from.
    origin: current.origin,
    evidenceStatus: current.evidenceStatus,
    createdBy: userId,
  });
  const images = await loadImagesForRevisions(db, [revision.id]);
  return toOwnerView(
    { ...question, currentRevisionId: revision.id },
    revision,
    images.get(revision.id),
  );
}

/**
 * Questions a new session may draw from, with the revision to pin. Excluded questions are
 * skipped, and so are revisions known to be bad (rejected or needing review), AI-generated
 * and not yet approved, or without an answer (see `src/lib/playability.ts`, which defines this
 * once for the server and the browser).
 */
export async function listPlayableItems(db: Database, setId: string) {
  const rows = await db
    .select({ questionId: questions.id, revisionId: questions.currentRevisionId })
    .from(questions)
    .innerJoin(questionRevisions, eq(questions.currentRevisionId, questionRevisions.id))
    .where(
      and(
        eq(questions.questionSetId, setId),
        eq(questions.status, "active"),
        notInArray(questionRevisions.evidenceStatus, [...PLAY_BLOCKING_EVIDENCE]),
        // A question with no answer cannot be graded, so it is not practised.
        sql`${questionRevisions.answerKey}->>'kind' <> ${NO_ANSWER_KIND}`,
      ),
    )
    .orderBy(asc(questions.position));
  return rows.map((r) => ({ questionId: r.questionId, revisionId: r.revisionId! }));
}

export async function listPlayableQuestionIds(db: Database, setId: string) {
  return (await listPlayableItems(db, setId)).map((item) => item.questionId);
}
