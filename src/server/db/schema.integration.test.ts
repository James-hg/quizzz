import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withTestTransaction } from "@/test/db";
import { insertAttempt } from "./repositories/attempts";
import { addRevision } from "./repositories/questions";
import {
  attempts,
  courses,
  questionRevisions,
  questionSets,
  questions,
  studySessions,
  user,
} from "./schema";

const tx = withTestTransaction();

async function seed() {
  const db = tx();
  const [owner] = await db
    .insert(user)
    .values({ name: "Test", email: `${randomUUID()}@example.test` })
    .returning();
  const ownerId = owner!.id;
  const [course] = await db
    .insert(courses)
    .values({ ownerId, title: "CS 101", subject: "Intro programming", language: "python" })
    .returning();
  const [set] = await db
    .insert(questionSets)
    .values({ courseId: course!.id, ownerId, title: "Week 1", origin: "manual" })
    .returning();
  const [question] = await db
    .insert(questions)
    .values({ questionSetId: set!.id, position: 0 })
    .returning();
  const revision = await addRevision(db, question!.id, {
    type: "mcq_single",
    prompt: "What does len([1, 2]) return?",
    options: [
      { id: "a", text: "1" },
      { id: "b", text: "2" },
    ],
    answerKey: { kind: "options", correctOptionIds: ["b"] },
    origin: "original",
  });
  const [session] = await db
    .insert(studySessions)
    .values({ userId: ownerId, courseId: course!.id, questionSetId: set!.id, mode: "quiz" })
    .returning();
  return {
    db,
    ownerId,
    course: course!,
    set: set!,
    question: question!,
    revision,
    session: session!,
  };
}

function attemptFor(s: Awaited<ReturnType<typeof seed>>, key = "key-1") {
  return {
    sessionId: s.session.id,
    userId: s.ownerId,
    questionId: s.question.id,
    questionRevisionId: s.revision.id,
    response: { kind: "options" as const, selectedOptionIds: ["b"] },
    isCorrect: true,
    gradingOutcome: "correct" as const,
    idempotencyKey: key,
    startedAt: new Date(),
  };
}

describe("core schema", () => {
  it("stores the full chain course -> set -> question + revision -> session -> attempt", async () => {
    const s = await seed();
    const attempt = await insertAttempt(s.db, attemptFor(s));
    expect(attempt.questionRevisionId).toBe(s.revision.id);
    const [q] = await s.db.select().from(questions).where(eq(questions.id, s.question.id));
    expect(q?.currentRevisionId).toBe(s.revision.id);
    expect(s.revision.revisionNumber).toBe(1);
    expect(attempt.submittedAt).toBeInstanceOf(Date);
  });

  it("rejects a duplicate (user, idempotency key)", async () => {
    const s = await seed();
    await insertAttempt(s.db, attemptFor(s));
    await expect(insertAttempt(s.db, attemptFor(s))).rejects.toThrow();
  });

  it("refuses to hard-delete a question that has attempts", async () => {
    const s = await seed();
    await insertAttempt(s.db, attemptFor(s));
    await expect(s.db.delete(questions).where(eq(questions.id, s.question.id))).rejects.toThrow();
  });

  it("refuses to change the content of a referenced revision", async () => {
    const s = await seed();
    await insertAttempt(s.db, attemptFor(s));
    await expect(
      s.db
        .update(questionRevisions)
        .set({ prompt: "changed" })
        .where(eq(questionRevisions.id, s.revision.id)),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/immutable/) } });
  });

  it("allows evidence_status to change on a referenced revision", async () => {
    const s = await seed();
    await insertAttempt(s.db, attemptFor(s));
    await s.db
      .update(questionRevisions)
      .set({ evidenceStatus: "human_reviewed" })
      .where(eq(questionRevisions.id, s.revision.id));
  });

  it("editing creates a new revision and leaves old attempts on the old one", async () => {
    const s = await seed();
    const attempt = await insertAttempt(s.db, attemptFor(s));
    const second = await addRevision(s.db, s.question.id, {
      type: "mcq_single",
      prompt: "Edited prompt",
      options: [{ id: "a", text: "2" }],
      answerKey: { kind: "options", correctOptionIds: ["a"] },
      origin: "original",
    });
    expect(second.revisionNumber).toBe(2);
    const [stored] = await s.db.select().from(attempts).where(eq(attempts.id, attempt.id));
    expect(stored?.questionRevisionId).toBe(s.revision.id);
  });

  it("never lets an attempt be rewritten", async () => {
    const s = await seed();
    const attempt = await insertAttempt(s.db, attemptFor(s));
    await expect(
      s.db.update(attempts).set({ isCorrect: false }).where(eq(attempts.id, attempt.id)),
    ).rejects.toThrow();
  });

  it("validates jsonb through the repository helpers", async () => {
    const s = await seed();
    await expect(
      addRevision(s.db, s.question.id, {
        type: "mcq_single",
        prompt: "bad",
        options: [{ id: "a", text: "x" }],
        answerKey: { kind: "options", correctOptionIds: [] },
        origin: "original",
      }),
    ).rejects.toThrow();
    await expect(
      insertAttempt(s.db, {
        ...attemptFor(s, "key-2"),
        response: { kind: "voice" } as never,
      }),
    ).rejects.toThrow();
  });
});
