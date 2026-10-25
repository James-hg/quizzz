import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyQuestion } from "@/lib/playability";
import { contentToRevision } from "@/lib/schemas";
import { getDb } from "@/server/db";
import { addRevision } from "@/server/db/repositories/questions";
import { questionRevisions, questions } from "@/server/db/schema";
import { startOrResumeSession } from "@/server/sessions/service";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { createCourse } from "./courses";
import { listQuestionSetsWithCounts } from "./overview";
import { playabilityForSet } from "./playability";
import { createQuestionSet } from "./question-sets";
import { listPlayableItems } from "./questions";

process.env.AUTH_RATE_LIMIT_MAX = "1000";
const db = getDb();
let alice: TestUser;
let bob: TestUser;
let courseId: string;

beforeAll(async () => {
  alice = await signUpUser(db);
  bob = await signUpUser(db);
  courseId = (await createCourse(db, alice.id, { title: "C", subject: "S" })).id;
});
afterAll(async () => {
  await deleteUsers(db, [alice.id, bob.id]);
});

type Seed = {
  status?: "active" | "excluded" | "reported";
  evidence: (typeof questionRevisions.$inferInsert)["evidenceStatus"];
  unresolvedKey?: boolean;
};

/** Inserts questions directly so every evidence/status combination can be exercised. */
async function seedSet(title: string, seeds: Seed[]) {
  const set = await createQuestionSet(db, alice.id, courseId, title);
  for (const [position, seed] of seeds.entries()) {
    const [question] = await db
      .insert(questions)
      .values({ questionSetId: set.id, position, status: seed.status ?? "active" })
      .returning();
    const content = contentToRevision({
      type: "mcq_single",
      prompt: `${title} q${position}`,
      options: [
        { id: "a", text: "x" },
        { id: "b", text: "y" },
      ],
      correctOptionIds: ["a"],
    });
    await addRevision(db, question!.id, {
      ...content,
      answerKey: seed.unresolvedKey ? { kind: "unresolved" } : content.answerKey,
      origin: "original",
      evidenceStatus: seed.evidence,
      createdBy: alice.id,
    });
  }
  return set;
}

const mixed: Seed[] = [
  { evidence: "human_reviewed" },
  { evidence: "unresolved" },
  { evidence: "needs_review" },
  { evidence: "needs_review" },
  { status: "excluded", evidence: "generated_unreviewed" },
  { status: "excluded", evidence: "unresolved", unresolvedKey: true },
  { status: "excluded", evidence: "human_reviewed" },
  { evidence: "rejected" },
];

describe("playability counts", () => {
  it("classifies each question once and explains the ones that cannot be practised", async () => {
    const set = await seedSet("Mixed", mixed);
    expect(await playabilityForSet(db, set.id)).toEqual({
      total: 8,
      playable: 2,
      needsReview: 3,
      noAnswer: 1,
      excluded: 2,
    });
  });

  it("agrees with the SQL filter that decides what a session contains", async () => {
    const set = await seedSet("Agree", mixed);
    const rows = await db
      .select({
        id: questions.id,
        status: questions.status,
        evidenceStatus: questionRevisions.evidenceStatus,
        kind: questionRevisions.answerKey,
      })
      .from(questions)
      .innerJoin(questionRevisions, eq(questions.currentRevisionId, questionRevisions.id))
      .where(eq(questions.questionSetId, set.id));
    const byFunction = rows
      .filter(
        (r) =>
          classifyQuestion({
            status: r.status,
            evidenceStatus: r.evidenceStatus,
            answerKind: r.kind.kind,
          }) === "playable",
      )
      .map((r) => r.id)
      .sort();
    const bySql = (await listPlayableItems(db, set.id)).map((i) => i.questionId).sort();
    expect(bySql).toEqual(byFunction);
    expect(bySql).toHaveLength(2);
  });

  it("adds the counts to the course's set list", async () => {
    const course = await createCourse(db, alice.id, { title: "Counts", subject: "S" });
    const set = await createQuestionSet(db, alice.id, course.id, "Needs review");
    for (const evidence of ["needs_review", "needs_review", "human_reviewed"] as const) {
      const [q] = await db
        .insert(questions)
        .values({ questionSetId: set.id, position: 0 })
        .returning();
      const content = contentToRevision({
        type: "mcq_single",
        prompt: "p",
        options: [
          { id: "a", text: "x" },
          { id: "b", text: "y" },
        ],
        correctOptionIds: ["a"],
      });
      await addRevision(db, q!.id, { ...content, origin: "sample", evidenceStatus: evidence });
    }
    const [row] = await listQuestionSetsWithCounts(db, alice.id, course.id);
    expect(row).toMatchObject({
      questionCount: 3,
      playableCount: 1,
      needsReviewCount: 2,
      noAnswerCount: 0,
      excludedCount: 0,
    });
  });
});

describe("no_playable_questions", () => {
  it("returns the counts so the client can say why", async () => {
    const set = await seedSet("Blocked", [
      { evidence: "needs_review" },
      { evidence: "needs_review" },
      { status: "excluded", evidence: "unresolved", unresolvedKey: true },
    ]);
    const error = await startOrResumeSession(db, alice.id, set.id).catch((e) => e);
    expect(error).toMatchObject({
      status: 409,
      code: "no_playable_questions",
      details: { total: 3, playable: 0, needsReview: 2, noAnswer: 1, excluded: 0 },
    });
  });

  it("still starts when at least one question can be practised", async () => {
    const set = await seedSet("Startable", mixed);
    const { session } = await startOrResumeSession(db, alice.id, set.id);
    expect(session.progress.total).toBe(2);
  });

  it("does not reveal counts for another user's set", async () => {
    const set = await seedSet("Private", [{ evidence: "needs_review" }]);
    await expect(startOrResumeSession(db, bob.id, set.id)).rejects.toMatchObject({ status: 404 });
  });
});
