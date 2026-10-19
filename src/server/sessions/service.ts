import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { assertOwnsQuestionSet, assertOwnsSession } from "@/server/auth/ownership";
import type { Database } from "@/server/db";
import { attempts, studySessions } from "@/server/db/schema";
import { listPlayableItems } from "@/server/content/questions";
import { conflict, notFound } from "@/server/http/errors";
import { buildSessionView, elapsedSecondsAt, type SessionRow } from "./view";

const isUniqueViolation = (error: unknown) =>
  (error as { cause?: { code?: string } }).cause?.code === "23505";

async function findLiveSession(db: Database, userId: string, setId: string) {
  const [row] = await db
    .select()
    .from(studySessions)
    .where(
      and(
        eq(studySessions.userId, userId),
        eq(studySessions.questionSetId, setId),
        eq(studySessions.mode, "quiz"),
        inArray(studySessions.state, ["active", "paused"]),
      ),
    );
  return row;
}

/**
 * Resumes the live quiz session for this set, or creates one. The item order and the revision
 * of every item are fixed now, so edits made later never change what this session shows or how
 * it is graded (they apply to the next session).
 */
export async function startOrResumeSession(
  db: Database,
  userId: string,
  setId: string,
  now: Date = new Date(),
) {
  const set = await assertOwnsQuestionSet(db, userId, setId);

  const existing = await findLiveSession(db, userId, setId);
  if (existing) return { created: false, session: await buildSessionView(db, existing, now) };

  const items = await listPlayableItems(db, setId);
  if (items.length === 0) {
    throw conflict(
      "This question set has no questions that can be practiced.",
      "no_playable_questions",
    );
  }

  try {
    const [row] = await db
      .insert(studySessions)
      .values({
        userId,
        courseId: set.courseId,
        questionSetId: setId,
        mode: "quiz",
        state: "active",
        itemOrder: items.map((i) => i.questionId),
        revisionIds: Object.fromEntries(items.map((i) => [i.questionId, i.revisionId])),
        startedAt: now,
        activeStartedAt: now,
      })
      .returning();
    return { created: true, session: await buildSessionView(db, row!, now) };
  } catch (error) {
    // Another request created the live session first; return that one.
    if (!isUniqueViolation(error)) throw error;
    const raced = await findLiveSession(db, userId, setId);
    if (!raced) throw error;
    return { created: false, session: await buildSessionView(db, raced, now) };
  }
}

export async function getSession(
  db: Database,
  userId: string,
  sessionId: string,
  now: Date = new Date(),
) {
  const session = await assertOwnsSession(db, userId, sessionId);
  return buildSessionView(db, session, now);
}

/** Locks the session row for the duration of a state change. */
export async function lockSession(
  db: Database,
  userId: string,
  sessionId: string,
): Promise<SessionRow> {
  const [row] = await db
    .select()
    .from(studySessions)
    .where(and(eq(studySessions.id, sessionId), eq(studySessions.userId, userId)))
    .for("update");
  if (!row) throw notFound("Session not found");
  return row;
}

const finished = () => conflict("This session has already ended.", "session_completed");

export async function pauseSession(
  db: Database,
  userId: string,
  sessionId: string,
  now: Date = new Date(),
) {
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const session = await lockSession(database, userId, sessionId);
    if (session.state === "paused") return;
    if (session.state !== "active") throw finished();
    await database
      .update(studySessions)
      .set({
        state: "paused",
        elapsedSeconds: elapsedSecondsAt(session, now),
        activeStartedAt: null,
      })
      .where(eq(studySessions.id, sessionId));
  });
  return getSession(db, userId, sessionId, now);
}

export async function resumeSession(
  db: Database,
  userId: string,
  sessionId: string,
  now: Date = new Date(),
) {
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const session = await lockSession(database, userId, sessionId);
    if (session.state === "active") return;
    if (session.state !== "paused") throw finished();
    await database
      .update(studySessions)
      .set({ state: "active", activeStartedAt: now })
      .where(eq(studySessions.id, sessionId));
  });
  return getSession(db, userId, sessionId, now);
}

export async function completeSession(
  db: Database,
  userId: string,
  sessionId: string,
  now: Date = new Date(),
) {
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const session = await lockSession(database, userId, sessionId);
    if (session.state === "completed") return;
    if (session.state !== "active" && session.state !== "paused") throw finished();
    await database
      .update(studySessions)
      .set({
        state: "completed",
        elapsedSeconds: elapsedSecondsAt(session, now),
        activeStartedAt: null,
        completedAt: now,
      })
      .where(eq(studySessions.id, sessionId));
  });

  const view = await getSession(db, userId, sessionId, now);
  const rows = await db
    .select({ outcome: attempts.gradingOutcome })
    .from(attempts)
    .where(eq(attempts.sessionId, sessionId));
  const count = (outcome: string) => rows.filter((r) => r.outcome === outcome).length;
  return {
    session: view,
    summary: {
      totalItems: view.progress.total,
      answered: rows.length,
      correct: count("correct"),
      incorrect: count("incorrect"),
      uncertain: count("uncertain"),
      unanswered: view.progress.total - view.progress.removed - rows.length,
      elapsedSeconds: view.elapsedSeconds,
    },
  };
}
