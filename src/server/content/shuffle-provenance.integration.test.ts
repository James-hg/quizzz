import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentToRevision } from "@/lib/schemas";
import { getDb } from "@/server/db";
import { addRevision } from "@/server/db/repositories/questions";
import { questionRevisions, questions } from "@/server/db/schema";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { createCourse } from "./courses";
import { createQuestionSet } from "./question-sets";
import { shuffleOptions } from "./questions";

process.env.AUTH_RATE_LIMIT_MAX = "1000";
const db = getDb();
let alice: TestUser;

beforeAll(async () => {
  alice = await signUpUser(db);
});
afterAll(async () => {
  await deleteUsers(db, [alice.id]);
});

async function seed(
  origin: "original" | "sample" | "ai_proposed",
  evidence: "human_reviewed" | "needs_review" | "generated_unreviewed",
) {
  const course = await createCourse(db, alice.id, { title: "C", subject: "S" });
  const set = await createQuestionSet(db, alice.id, course.id, "Set");
  const [question] = await db
    .insert(questions)
    .values({ questionSetId: set.id, position: 0 })
    .returning();
  await addRevision(db, question!.id, {
    ...contentToRevision({
      type: "mcq_single",
      prompt: "Which is right?",
      options: [
        { id: "a", text: "one" },
        { id: "b", text: "two" },
        { id: "c", text: "three" },
      ],
      correctOptionIds: ["b"],
    }),
    origin,
    evidenceStatus: evidence,
    createdBy: alice.id,
  });
  return question!.id;
}

describe("shuffling options keeps provenance", () => {
  it.each([
    ["sample", "needs_review"],
    ["ai_proposed", "generated_unreviewed"],
    ["original", "human_reviewed"],
  ] as const)("keeps origin %s and evidence %s", async (origin, evidence) => {
    const id = await seed(origin, evidence);
    await shuffleOptions(db, alice.id, id, () => 0);
    const revisions = await db
      .select()
      .from(questionRevisions)
      .where(eq(questionRevisions.questionId, id))
      .orderBy(asc(questionRevisions.revisionNumber));
    expect(revisions).toHaveLength(2);
    expect(revisions[1]).toMatchObject({ origin, evidenceStatus: evidence });
    // Only the order changed; the answer key still points at the same option id.
    expect(revisions[1]!.answerKey).toEqual({ kind: "options", correctOptionIds: ["b"] });
    expect(revisions[1]!.prompt).toBe("Which is right?");
  });
});
