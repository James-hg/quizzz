import "server-only";
import { eq, inArray } from "drizzle-orm";
import { revealAnswer } from "@/server/grading";
import { disclosureFor, isEnded, type Disclosure, type Pass } from "./reveal";
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

type AnswerOutcome = "correct" | "incorrect" | "uncertain";

/**
 * The result shown to the student after they have submitted, limited to what `disclosure`
 * allows. Built only from an attempt; the answer key is read only for a `full` disclosure.
 */
export function resultOf(
  attempt: AttemptRow,
  revision: RevisionRow,
  disclosure: Disclosure = "full",
) {
  const base = {
    attemptId: attempt.id,
    pass: attempt.pass as Pass,
    response: attempt.response,
    submittedAt: attempt.submittedAt,
  };
  if (disclosure === "none") return { ...base, disclosure } as const;
  const verdict = {
    ...base,
    outcome: attempt.gradingOutcome as AnswerOutcome,
    isCorrect: attempt.isCorrect,
  };
  if (disclosure === "verdict") return { ...verdict, disclosure } as const;
  return {
    ...verdict,
    correctAnswer: revealAnswer(revision.answerKey),
    explanation: revision.explanation,
    disclosure,
  } as const;
}

/**
 * What the student may see of a question before answering: no key, no explanation. The only
 * thing derived from the key is how many blanks a fill-in question has, which the form needs.
 */
function questionForPlay(revision: RevisionRow, questionId: string) {
  return {
    questionId,
    revisionNumber: revision.revisionNumber,
    type: revision.type,
    prompt: revision.prompt,
    codeSnippet: revision.codeSnippet,
    options: revision.options.map((o) => ({ id: o.id, text: o.text })),
    ...(revision.answerKey.kind === "blanks"
      ? { blankCount: revision.answerKey.blanks.length }
      : {}),
  };
}

export type SessionItem =
  | { questionId: string; position: number; pass: Pass; status: "pending" }
  | { questionId: string; position: number; pass: Pass; status: "removed" }
  | {
      questionId: string;
      position: number;
      pass: Pass;
      status: "answered";
      result: ReturnType<typeof resultOf>;
    };

/** The questions a session asks, in order: every question once, then the retries (requeue). */
export function sessionSlots(session: Pick<SessionRow, "itemOrder" | "retryOrder">) {
  return [
    ...session.itemOrder.map((questionId) => ({ questionId, pass: 1 as Pass })),
    ...session.retryOrder.map((questionId) => ({ questionId, pass: 2 as Pass })),
  ];
}

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
  const attemptAt = new Map(sessionAttempts.map((a) => [`${a.questionId}:${a.pass}`, a]));
  const ended = isEnded(session.state);

  const items: SessionItem[] = sessionSlots(session).map(({ questionId, pass }, position) => {
    const attempt = attemptAt.get(`${questionId}:${pass}`);
    const revision = revisions.get(session.revisionIds[questionId] ?? "");
    if (attempt && revision) {
      const disclosure = disclosureFor({
        mode: session.revealMode,
        sessionEnded: ended,
        pass,
        outcome: attempt.gradingOutcome,
        retryAnswered: attemptAt.has(`${questionId}:2`),
      });
      return {
        questionId,
        position,
        pass,
        status: "answered",
        result: resultOf(attempt, revision, disclosure),
      };
    }
    if (!revision) return { questionId, position, pass, status: "removed" };
    return { questionId, position, pass, status: "pending" };
  });

  const currentIndex = firstPendingIndex(items);
  const pending = items[currentIndex];
  const currentRevision =
    pending && session.state !== "completed"
      ? revisions.get(session.revisionIds[pending.questionId] ?? "")
      : undefined;

  return {
    id: session.id,
    questionSetId: session.questionSetId,
    courseId: session.courseId,
    mode: session.mode,
    revealMode: session.revealMode,
    state: session.state,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    elapsedSeconds: elapsedSecondsAt(session, now),
    currentIndex,
    progress: {
      total: items.length,
      answered: items.filter((i) => i.status === "answered").length,
      removed: items.filter((i) => i.status === "removed").length,
      retries: session.retryOrder.length,
    },
    items,
    current:
      pending && currentRevision
        ? { ...questionForPlay(currentRevision, pending.questionId), pass: pending.pass }
        : null,
  };
}

export type SessionView = Awaited<ReturnType<typeof buildSessionView>>;
