import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentToRevision } from "@/lib/schemas";
import { createCourse } from "@/server/content/courses";
import { createQuestionSet } from "@/server/content/question-sets";
import { getDb } from "@/server/db";
import { insertAttempt } from "@/server/db/repositories/attempts";
import { addRevision } from "@/server/db/repositories/questions";
import { attempts, questionRevisions, questions, studySessions } from "@/server/db/schema";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";

process.env.AUTH_RATE_LIMIT_MAX = "1000";
const db = getDb();
let alice: TestUser;
let setId: string;
let courseId: string;

const migration = readFileSync(
  join(process.cwd(), "drizzle", "0006_owner_questions_reviewed.sql"),
  "utf8",
)
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

beforeAll(async () => {
  alice = await signUpUser(db);
  courseId = (await createCourse(db, alice.id, { title: "C", subject: "S" })).id;
  setId = (await createQuestionSet(db, alice.id, courseId, "Backfill")).id;
});
afterAll(async () => {
  await deleteUsers(db, [alice.id]);
});

type Seed = {
  name: string;
  origin: "original" | "ai_proposed" | "sample";
  evidence: (typeof questionRevisions.$inferInsert)["evidenceStatus"];
  unresolvedKey?: boolean;
};

const seeds: (Seed & { expected: string })[] = [
  {
    name: "owner, resolved answer, old label",
    origin: "original",
    evidence: "unresolved",
    expected: "human_reviewed",
  },
  {
    name: "owner, answer missing",
    origin: "original",
    evidence: "unresolved",
    unresolvedKey: true,
    expected: "unresolved",
  },
  {
    name: "AI-proposed, old label",
    origin: "ai_proposed",
    evidence: "unresolved",
    expected: "unresolved",
  },
  {
    name: "sample, needs review",
    origin: "sample",
    evidence: "needs_review",
    expected: "needs_review",
  },
  {
    name: "owner, already reviewed",
    origin: "original",
    evidence: "human_reviewed",
    expected: "human_reviewed",
  },
  { name: "owner, rejected", origin: "original", evidence: "rejected", expected: "rejected" },
];

async function seedRows() {
  const ids = new Map<string, string>();
  for (const [position, seed] of seeds.entries()) {
    const [question] = await db
      .insert(questions)
      .values({ questionSetId: setId, position })
      .returning();
    const content = contentToRevision({
      type: "mcq_single",
      prompt: seed.name,
      options: [
        { id: "a", text: "x" },
        { id: "b", text: "y" },
      ],
      correctOptionIds: ["a"],
    });
    const revision = await addRevision(db, question!.id, {
      ...content,
      answerKey: seed.unresolvedKey ? { kind: "unresolved" } : content.answerKey,
      origin: seed.origin,
      evidenceStatus: seed.evidence,
      createdBy: alice.id,
    });
    ids.set(seed.name, revision.id);
  }
  return ids;
}

async function evidenceOf(ids: Map<string, string>) {
  const rows = await db
    .select({ id: questionRevisions.id, evidence: questionRevisions.evidenceStatus })
    .from(questionRevisions)
    .where(inArray(questionRevisions.id, [...ids.values()]));
  return Object.fromEntries(
    [...ids.entries()].map(([name, id]) => [name, rows.find((r) => r.id === id)?.evidence]),
  );
}

describe("migration 0006: owner questions with an answer are reviewed", () => {
  it("changes exactly the owner questions that have an answer, and nothing else", async () => {
    const ids = await seedRows();
    await db.execute(sql.raw(migration));
    expect(await evidenceOf(ids)).toEqual(
      Object.fromEntries(seeds.map((s) => [s.name, s.expected])),
    );
  });

  it("is idempotent", async () => {
    const ids = await seedRows();
    await db.execute(sql.raw(migration));
    const once = await evidenceOf(ids);
    await db.execute(sql.raw(migration));
    expect(await evidenceOf(ids)).toEqual(once);
  });

  it("leaves content and attempts untouched, even on a revision that already has attempts", async () => {
    const [question] = await db
      .insert(questions)
      .values({ questionSetId: setId, position: 99 })
      .returning();
    const content = contentToRevision({
      type: "mcq_single",
      prompt: "Attempted",
      options: [
        { id: "a", text: "x" },
        { id: "b", text: "y" },
      ],
      correctOptionIds: ["b"],
    });
    const revision = await addRevision(db, question!.id, {
      ...content,
      origin: "original",
      evidenceStatus: "unresolved",
      createdBy: alice.id,
    });
    const [session] = await db
      .insert(studySessions)
      .values({ userId: alice.id, courseId, questionSetId: setId, mode: "quiz" })
      .returning();
    const attempt = await insertAttempt(db, {
      sessionId: session!.id,
      userId: alice.id,
      questionId: question!.id,
      questionRevisionId: revision.id,
      response: { kind: "options", selectedOptionIds: ["b"] },
      isCorrect: true,
      gradingOutcome: "correct",
      idempotencyKey: "migration-0006-attempt",
      startedAt: new Date(),
    });
    const before = await db
      .select()
      .from(questionRevisions)
      .where(eq(questionRevisions.id, revision.id));

    await db.execute(sql.raw(migration));

    const [after] = await db
      .select()
      .from(questionRevisions)
      .where(eq(questionRevisions.id, revision.id));
    expect(after).toEqual({ ...before[0], evidenceStatus: "human_reviewed" });
    const [storedAttempt] = await db.select().from(attempts).where(eq(attempts.id, attempt.id));
    expect(storedAttempt).toEqual(attempt);
  });
});
