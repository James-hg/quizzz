import "server-only";
import { eq, inArray } from "drizzle-orm";
import type { QuestionImageView } from "@/lib/images";
import { loadImagesForRevisions } from "@/server/images/service";
import { revealAnswer } from "@/server/grading";
import type { Database } from "@/server/db";
import { parseRevisionJson } from "@/server/db/repositories/questions";
import { attempts, questionRevisions, studySessions } from "@/server/db/schema";

export type SessionRow = typeof studySessions.$inferSelect;
type AttemptRow = typeof attempts.$inferSelect;
type RevisionRow = typeof questionRevisions.$inferSelect;

/** Whole seconds the session has been running, including the current active stretch. */
export function elapsedSecondsAt(session: SessionRow, now: Date): number {
  if (session.state === "active" && session.activeStartedAt) {
    const running = Math.round((now.getTime() - session.activeStartedAt.getTime()) / 1000);
    return session.elapsedSeconds + Math.max(0, running);
  }
  return session.elapsedSeconds;
}

/** The result shown to the student after they have submitted. Built only from an attempt. */
export function resultOf(attempt: AttemptRow, revision: RevisionRow) {
  return {
    attemptId: attempt.id,
    outcome: attempt.gradingOutcome,
    isCorrect: attempt.isCorrect,
    response: attempt.response,
    correctAnswer: revealAnswer(revision.answerKey),
    explanation: revision.explanation,
    submittedAt: attempt.submittedAt,
  };
}

/**
 * What the student may see of a question before answering: no key, no explanation. The only
 * thing derived from the key is how many blanks a fill-in question has, which the form needs.
 */
function questionForPlay(
  revision: RevisionRow,
  questionId: string,
  image: QuestionImageView | null,
) {
  return {
    questionId,
    revisionNumber: revision.revisionNumber,
    type: revision.type,
    prompt: revision.prompt,
    codeSnippet: revision.codeSnippet,
    // Images are part of the question, not of the answer, so they are shown before submitting.
    image,
    options: revision.options.map((o) => ({ id: o.id, text: o.text })),
    ...(revision.answerKey.kind === "blanks"
      ? { blankCount: revision.answerKey.blanks.length }
      : {}),
  };
}

export type SessionItem =
  | { questionId: string; position: number; status: "pending" }
  | { questionId: string; position: number; status: "removed" }
  | {
      questionId: string;
      position: number;
      status: "answered";
      result: ReturnType<typeof resultOf>;
    };

export async function loadAttempts(db: Database, sessionId: string) {
  return db.select().from(attempts).where(eq(attempts.sessionId, sessionId));
}

export async function loadPinnedRevisions(db: Database, session: SessionRow) {
  const ids = Object.values(session.revisionIds);
  if (ids.length === 0) return new Map<string, RevisionRow>();
  const rows = await db.select().from(questionRevisions).where(inArray(questionRevisions.id, ids));
  return new Map(rows.map((r) => [r.id, parseRevisionJson(r)]));
}

/** Index of the first item that still needs an answer, or the item count when none do. */
export function firstPendingIndex(items: { status: string }[]): number {
  const index = items.findIndex((item) => item.status === "pending");
  return index === -1 ? items.length : index;
}

export async function buildSessionView(db: Database, session: SessionRow, now: Date) {
  const [sessionAttempts, revisions] = await Promise.all([
    loadAttempts(db, session.id),
    loadPinnedRevisions(db, session),
  ]);
  const attemptByQuestion = new Map(sessionAttempts.map((a) => [a.questionId, a]));

  const items: SessionItem[] = session.itemOrder.map((questionId, position) => {
    const attempt = attemptByQuestion.get(questionId);
    const revision = revisions.get(session.revisionIds[questionId] ?? "");
    if (attempt && revision) {
      return { questionId, position, status: "answered", result: resultOf(attempt, revision) };
    }
    if (!revision) return { questionId, position, status: "removed" };
    return { questionId, position, status: "pending" };
  });

  const currentIndex = firstPendingIndex(items);
  const pending = items[currentIndex];
  const currentRevision =
    pending && session.state !== "completed"
      ? revisions.get(session.revisionIds[pending.questionId] ?? "")
      : undefined;

  const currentImages = currentRevision
    ? await loadImagesForRevisions(db, [currentRevision.id])
    : new Map<string, QuestionImageView>();

  return {
    id: session.id,
    questionSetId: session.questionSetId,
    courseId: session.courseId,
    mode: session.mode,
    state: session.state,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    elapsedSeconds: elapsedSecondsAt(session, now),
    currentIndex,
    progress: {
      total: items.length,
      answered: items.filter((i) => i.status === "answered").length,
      removed: items.filter((i) => i.status === "removed").length,
    },
    items,
    current:
      pending && currentRevision
        ? questionForPlay(
            currentRevision,
            pending.questionId,
            currentImages.get(currentRevision.id) ?? null,
          )
        : null,
  };
}

export type SessionView = Awaited<ReturnType<typeof buildSessionView>>;
