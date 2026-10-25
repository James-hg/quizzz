import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentToRevision } from "@/lib/schemas";
import { getDb } from "@/server/db";
import { addRevision } from "@/server/db/repositories/questions";
import { questionRevisions, questions } from "@/server/db/schema";
import { startOrResumeSession } from "@/server/sessions/service";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { createCourse } from "./courses";
import { createQuestionSet } from "./question-sets";
import { playabilityForSet } from "./playability";
import {
  createQuestion,
  getQuestion,
  listPlayableItems,
  setQuestionStatus,
  updateQuestion,
} from "./questions";

process.env.AUTH_RATE_LIMIT_MAX = "1000";
const db = getDb();
let alice: TestUser;
let courseId: string;

beforeAll(async () => {
  alice = await signUpUser(db);
  courseId = (await createCourse(db, alice.id, { title: "C", subject: "S" })).id;
});
afterAll(async () => {
  await deleteUsers(db, [alice.id]);
});

const mcq = (prompt: string) => ({
  type: "mcq_single" as const,
  prompt,
  options: [
    { id: "a", text: "one" },
    { id: "b", text: "two" },
  ],
  correctOptionIds: ["a"],
});

type Seed = {
  origin: "original" | "ai_proposed" | "ai_variant" | "sample";
  evidence: (typeof questionRevisions.$inferInsert)["evidenceStatus"];
  status?: "active" | "excluded";
};

/** A question whose provenance the editor cannot produce, so every origin can be exercised. */
async function seed(setId: string, { origin, evidence, status = "active" }: Seed) {
  const [question] = await db
    .insert(questions)
    .values({ questionSetId: setId, position: 0, status })
    .returning();
  await addRevision(db, question!.id, {
    ...contentToRevision(mcq("Seeded")),
    origin,
    evidenceStatus: evidence,
    createdBy: alice.id,
  });
  return question!.id;
}

async function freshSet(title: string) {
  return createQuestionSet(db, alice.id, courseId, title);
}

describe("review state of owner questions", () => {
  it("counts a question the owner writes, with an answer, as reviewed and playable", async () => {
    const set = await freshSet("Own");
    const created = await createQuestion(db, alice.id, set.id, mcq("Pick one"), false);
    expect(created).toMatchObject({ origin: "original", evidenceStatus: "human_reviewed" });
    const { created: started } = await startOrResumeSession(db, alice.id, set.id);
    expect(started).toBe(true);
  });

  it("ignores the approve flag for owner questions in both directions", async () => {
    const set = await freshSet("Flag");
    const ticked = await createQuestion(db, alice.id, set.id, mcq("A"), true);
    const unticked = await createQuestion(db, alice.id, set.id, mcq("B"), false);
    expect(ticked.evidenceStatus).toBe("human_reviewed");
    expect(unticked.evidenceStatus).toBe("human_reviewed");
  });

  it("keeps an edited owner question reviewed, and repairs one stored as unresolved", async () => {
    const set = await freshSet("Edit");
    const q = await createQuestion(db, alice.id, set.id, mcq("Before"), false);
    const edited = await updateQuestion(db, alice.id, q.id, { prompt: "After" });
    expect(edited).toMatchObject({ revisionNumber: 2, evidenceStatus: "human_reviewed" });

    // A row written before this rule existed: owner question, resolved answer, unresolved label.
    const legacyId = await seed(set.id, { origin: "original", evidence: "unresolved" });
    const fixed = await updateQuestion(db, alice.id, legacyId, { prompt: "Legacy edited" });
    expect(fixed.evidenceStatus).toBe("human_reviewed");
  });
});

describe("review state of questions that did not come from the owner", () => {
  it("keeps an AI-proposed question unreviewed when edited without approval", async () => {
    const set = await freshSet("AI");
    const id = await seed(set.id, {
      origin: "ai_proposed",
      evidence: "generated_unreviewed",
      status: "excluded",
    });
    const edited = await updateQuestion(db, alice.id, id, { prompt: "Tweaked wording" });
    expect(edited).toMatchObject({ origin: "ai_proposed", evidenceStatus: "generated_unreviewed" });

    const approved = await updateQuestion(db, alice.id, id, {
      prompt: "Tweaked again",
      approve: true,
    });
    expect(approved).toMatchObject({ origin: "ai_proposed", evidenceStatus: "human_reviewed" });
  });

  it("keeps a sample question in needs_review until approved, without changing its origin", async () => {
    const set = await freshSet("Sample");
    const id = await seed(set.id, { origin: "sample", evidence: "needs_review" });
    const edited = await updateQuestion(db, alice.id, id, { prompt: "Sample tweaked" });
    expect(edited).toMatchObject({ origin: "sample", evidenceStatus: "needs_review" });
    const approved = await updateQuestion(db, alice.id, id, {
      prompt: "Sample reviewed",
      approve: true,
    });
    expect(approved).toMatchObject({ origin: "sample", evidenceStatus: "human_reviewed" });
  });

  it("asks for another review when a checked sample question is edited without approval", async () => {
    const set = await freshSet("Checked sample");
    const id = await seed(set.id, { origin: "sample", evidence: "human_reviewed" });
    const edited = await updateQuestion(db, alice.id, id, { prompt: "Changed after checking" });
    expect(edited.evidenceStatus).toBe("needs_review");
  });

  it("keeps a rejected question rejected until the owner approves it", async () => {
    const set = await freshSet("Rejected");
    const id = await seed(set.id, {
      origin: "ai_variant",
      evidence: "rejected",
      status: "excluded",
    });
    const edited = await updateQuestion(db, alice.id, id, { prompt: "Fixed up" });
    expect(edited.evidenceStatus).toBe("rejected");
  });

  it("records the review state on the stored revision, not just the response", async () => {
    const set = await freshSet("Stored");
    const id = await seed(set.id, { origin: "sample", evidence: "needs_review" });
    await updateQuestion(db, alice.id, id, { prompt: "Stored check" });
    const [row] = await db
      .select({ e: questionRevisions.evidenceStatus, n: questionRevisions.revisionNumber })
      .from(questionRevisions)
      .where(eq(questionRevisions.questionId, id))
      .orderBy(questionRevisions.revisionNumber);
    expect(row).toMatchObject({ e: "needs_review", n: 1 });
    const latest = await getQuestion(db, alice.id, id);
    expect(latest).toMatchObject({ revisionNumber: 2, evidenceStatus: "needs_review" });
  });
});

describe("questions without an answer", () => {
  it("are not playable and not restorable, however they are labelled", async () => {
    const set = await freshSet("No answer");
    const [question] = await db
      .insert(questions)
      .values({ questionSetId: set.id, position: 0, status: "active" })
      .returning();
    await addRevision(db, question!.id, {
      ...contentToRevision(mcq("No key yet")),
      answerKey: { kind: "unresolved" },
      origin: "original",
      evidenceStatus: "unresolved",
      createdBy: alice.id,
    });
    expect(await listPlayableItems(db, set.id)).toEqual([]);
    expect(await playabilityForSet(db, set.id)).toMatchObject({
      total: 1,
      playable: 0,
      noAnswer: 1,
    });
    await expect(startOrResumeSession(db, alice.id, set.id)).rejects.toMatchObject({
      code: "no_playable_questions",
    });
    await expect(setQuestionStatus(db, alice.id, question!.id, "active")).rejects.toMatchObject({
      code: "unresolved_answer",
    });

    // Setting the answer through the editor makes it reviewed and playable.
    await updateQuestion(db, alice.id, question!.id, { correctOptionIds: ["b"] });
    const [playable] = await listPlayableItems(db, set.id);
    expect(playable?.questionId).toBe(question!.id);
  });
});

describe("restoring questions", () => {
  it.each(["needs_review", "generated_unreviewed", "rejected"] as const)(
    "refuses to include a %s question in practice until it is approved",
    async (evidence) => {
      const set = await freshSet(`Restore ${evidence}`);
      const id = await seed(set.id, { origin: "sample", evidence, status: "excluded" });
      await expect(setQuestionStatus(db, alice.id, id, "active")).rejects.toMatchObject({
        status: 409,
        code: "needs_review",
      });
    },
  );

  it("allows including an approved question", async () => {
    const set = await freshSet("Restore ok");
    const id = await seed(set.id, {
      origin: "sample",
      evidence: "needs_review",
      status: "excluded",
    });
    await updateQuestion(db, alice.id, id, { prompt: "Now reviewed", approve: true });
    const restored = await setQuestionStatus(db, alice.id, id, "active");
    expect(restored.status).toBe("active");
  });
});
