import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentToRevision, type QuestionContent } from "@/lib/schemas";
import { getDb } from "@/server/db";
import { insertAttempt } from "@/server/db/repositories/attempts";
import { addRevision } from "@/server/db/repositories/questions";
import {
  attempts,
  questionRewrites,
  questionRevisions,
  questions,
  studySessions,
} from "@/server/db/schema";
import { LocalStorageAdapter } from "@/server/storage/local";
import { PNG_BYTES } from "@/test/images";
import { createImage, loadImagesForRevisions } from "@/server/images/service";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { createCourse } from "./courses";
import { createQuestionSet } from "./question-sets";
import {
  acceptRewrite,
  acceptRewriteSchema,
  dismissRewrite,
  listRewrites,
  saveRewrite,
} from "./rewrites";
import {
  createQuestion,
  getQuestion,
  listPlayableItems,
  listQuestions,
  updateQuestion,
} from "./questions";

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

const original: QuestionContent = {
  type: "mcq_single",
  prompt: "What is 3 + 4?",
  options: [
    { id: "a", text: "7" },
    { id: "b", text: "8" },
    { id: "c", text: "12" },
  ],
  correctOptionIds: ["a"],
};

async function fresh() {
  const set = await createQuestionSet(db, alice.id, courseId, `Set ${Math.random()}`);
  const question = await createQuestion(db, alice.id, set.id, original, false);
  return { set, question };
}

const rephrased: QuestionContent = {
  ...original,
  prompt: "Work out 3 plus 4.",
  options: [
    { id: "a", text: "seven (7)" },
    { id: "b", text: "eight (8)" },
    { id: "c", text: "twelve (12)" },
  ],
};

const varied: QuestionContent = {
  ...original,
  prompt: "What is 5 + 6?",
  options: [
    { id: "a", text: "11" },
    { id: "b", text: "12" },
    { id: "c", text: "56" },
  ],
};

const explained: QuestionContent = { ...original, explanation: "3 + 4 = 7." };

const propose = (
  questionId: string,
  mode: "rephrase" | "vary_numbers" | "add_explanation",
  content: QuestionContent,
  baseRevisionId: string,
  user = alice,
) => saveRewrite(db, user.id, questionId, { mode, baseRevisionId, content });

describe("saving a proposal", () => {
  it("stores it as pending and leaves the question, its revision and practice untouched", async () => {
    const { set, question } = await fresh();
    const proposal = await propose(question.id, "rephrase", rephrased, question.revisionId);
    expect(proposal).toMatchObject({
      mode: "rephrase",
      origin: "ai_variant",
      evidenceStatus: "generated_unreviewed",
      stale: false,
    });

    const after = await getQuestion(db, alice.id, question.id);
    expect(after).toMatchObject({
      revisionNumber: 1,
      prompt: original.prompt,
      evidenceStatus: "human_reviewed",
    });
    expect(await listPlayableItems(db, set.id)).toHaveLength(1);
    expect((await listQuestions(db, alice.id, set.id)).map((q) => q.prompt)).toEqual([
      original.prompt,
    ]);
  });

  it("takes origin and review state from the mode, with varied numbers always needing review", async () => {
    const { question } = await fresh();
    expect(await propose(question.id, "vary_numbers", varied, question.revisionId)).toMatchObject({
      origin: "ai_variant",
      evidenceStatus: "needs_review",
    });
    expect(
      await propose(question.id, "add_explanation", explained, question.revisionId),
    ).toMatchObject({
      origin: "ai_proposed",
      evidenceStatus: "generated_unreviewed",
    });
  });

  it("refuses a proposal that breaks the rules of its mode, and stores nothing", async () => {
    const { question } = await fresh();
    const sneaky = { ...rephrased, correctOptionIds: ["b"] };
    await expect(
      propose(question.id, "rephrase", sneaky, question.revisionId),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_proposal",
    });
    await expect(
      propose(question.id, "vary_numbers", original, question.revisionId),
    ).rejects.toMatchObject({
      code: "invalid_proposal",
    });
    expect(await listRewrites(db, alice.id, question.id)).toEqual([]);
  });

  it("refuses a proposal based on an older revision, and one for someone else's question", async () => {
    const { question } = await fresh();
    await updateQuestion(db, alice.id, question.id, { prompt: "What is 3 + 4? (edited)" });
    await expect(
      propose(question.id, "rephrase", rephrased, question.revisionId),
    ).rejects.toMatchObject({
      status: 409,
      code: "stale_proposal",
    });
    await expect(
      propose(question.id, "rephrase", rephrased, question.revisionId, bob),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("will not rewrite a question that has no answer yet", async () => {
    const set = await createQuestionSet(db, alice.id, courseId, "No answer");
    const [q] = await db
      .insert(questions)
      .values({ questionSetId: set.id, position: 0 })
      .returning();
    const revision = await addRevision(db, q!.id, {
      ...contentToRevision(original),
      answerKey: { kind: "unresolved" },
      origin: "original",
      evidenceStatus: "unresolved",
      createdBy: alice.id,
    });
    await expect(propose(q!.id, "rephrase", rephrased, revision.id)).rejects.toMatchObject({
      code: "unresolved_answer",
    });
  });
});

describe("listing", () => {
  it("shows only pending proposals, flags stale ones, and is private", async () => {
    const { question } = await fresh();
    const keep = await propose(question.id, "add_explanation", explained, question.revisionId);
    const drop = await propose(question.id, "rephrase", rephrased, question.revisionId);
    await dismissRewrite(db, alice.id, drop.id);

    expect((await listRewrites(db, alice.id, question.id)).map((r) => [r.id, r.stale])).toEqual([
      [keep.id, false],
    ]);
    await updateQuestion(db, alice.id, question.id, { prompt: "What is 3 + 4? (edited)" });
    expect((await listRewrites(db, alice.id, question.id))[0]!.stale).toBe(true);
    await expect(listRewrites(db, bob.id, question.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("accepting", () => {
  it("requires the owner's confirmation", () => {
    expect(acceptRewriteSchema.safeParse({}).success).toBe(false);
    expect(acceptRewriteSchema.safeParse({ confirmed: false }).success).toBe(false);
    expect(acceptRewriteSchema.parse({ confirmed: true })).toEqual({
      confirmed: true,
      as: "revision",
    });
  });

  it("adds a revision, keeps where it came from, counts as reviewed, and leaves attempts on the old one", async () => {
    const { set, question } = await fresh();
    const [session] = await db
      .insert(studySessions)
      .values({ userId: alice.id, courseId, questionSetId: set.id, mode: "quiz" })
      .returning();
    const attempt = await insertAttempt(db, {
      sessionId: session!.id,
      userId: alice.id,
      questionId: question.id,
      questionRevisionId: question.revisionId,
      response: { kind: "options", selectedOptionIds: ["a"] },
      isCorrect: true,
      gradingOutcome: "correct",
      idempotencyKey: `rewrite-${Math.random()}`,
      startedAt: new Date(),
    });
    const proposal = await propose(question.id, "rephrase", rephrased, question.revisionId);

    const accepted = await acceptRewrite(db, alice.id, proposal.id, {
      confirmed: true,
      as: "revision",
    });
    expect(accepted.replayed).toBe(false);
    expect(accepted.question).toMatchObject({
      id: question.id,
      revisionNumber: 2,
      prompt: "Work out 3 plus 4.",
      origin: "ai_variant",
      evidenceStatus: "human_reviewed",
    });
    expect(await listPlayableItems(db, set.id)).toHaveLength(1);

    // The old revision and the attempt that points at it are unchanged.
    const [old] = await db
      .select()
      .from(questionRevisions)
      .where(eq(questionRevisions.id, question.revisionId));
    expect(old).toMatchObject({ revisionNumber: 1, prompt: original.prompt });
    const [stored] = await db.select().from(attempts).where(eq(attempts.id, attempt.id));
    expect(stored).toEqual(attempt);
  });

  it("is idempotent: a retry returns the same result and adds no second revision", async () => {
    const { question } = await fresh();
    const proposal = await propose(question.id, "add_explanation", explained, question.revisionId);
    const first = await acceptRewrite(db, alice.id, proposal.id, {
      confirmed: true,
      as: "revision",
    });
    const second = await acceptRewrite(db, alice.id, proposal.id, {
      confirmed: true,
      as: "revision",
    });
    expect(second.replayed).toBe(true);
    expect(second.question.revisionId).toBe(first.question.revisionId);
    const revisions = await db
      .select()
      .from(questionRevisions)
      .where(eq(questionRevisions.questionId, question.id));
    expect(revisions).toHaveLength(2);
    expect(first.question).toMatchObject({
      explanation: "3 + 4 = 7.",
      origin: "ai_proposed",
      evidenceStatus: "human_reviewed",
    });
    await expect(dismissRewrite(db, alice.id, proposal.id)).rejects.toMatchObject({
      code: "already_resolved",
    });
  });

  it("makes varied numbers reviewed only through acceptance", async () => {
    const { question } = await fresh();
    const proposal = await propose(question.id, "vary_numbers", varied, question.revisionId);
    expect(proposal.evidenceStatus).toBe("needs_review");
    const accepted = await acceptRewrite(db, alice.id, proposal.id, {
      confirmed: true,
      as: "revision",
    });
    expect(accepted.question).toMatchObject({
      prompt: "What is 5 + 6?",
      origin: "ai_variant",
      evidenceStatus: "human_reviewed",
    });
  });

  it("can add the rewrite as a separate question and leave the original alone", async () => {
    const { set, question } = await fresh();
    const proposal = await propose(question.id, "vary_numbers", varied, question.revisionId);
    const accepted = await acceptRewrite(db, alice.id, proposal.id, {
      confirmed: true,
      as: "new_question",
    });
    expect(accepted.question.id).not.toBe(question.id);
    expect(accepted.question).toMatchObject({
      prompt: "What is 5 + 6?",
      status: "active",
      position: 1,
    });
    const all = await listQuestions(db, alice.id, set.id);
    expect(all.map((q) => q.prompt)).toEqual([original.prompt, "What is 5 + 6?"]);
    expect((await getQuestion(db, alice.id, question.id)).revisionNumber).toBe(1);
    expect(await listPlayableItems(db, set.id)).toHaveLength(2);
  });

  it("keeps the picture when the rewrite is added as a separate question", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "quizzz-rewrite-"));
    try {
      const { question } = await fresh();
      const image = await createImage(
        db,
        new LocalStorageAdapter(dir),
        alice.id,
        PNG_BYTES,
        2 * 1024 * 1024,
      );
      const withImage = await updateQuestion(db, alice.id, question.id, {
        image: { imageId: image.id, alt: "A diagram" },
      });
      const proposal = await propose(question.id, "rephrase", rephrased, withImage.revisionId);
      const added = await acceptRewrite(db, alice.id, proposal.id, {
        confirmed: true,
        as: "new_question",
      });
      const shown = await loadImagesForRevisions(db, [added.question.revisionId]);
      expect(shown.get(added.question.revisionId)).toMatchObject({
        id: image.id,
        alt: "A diagram",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lets only one of two proposals for the same revision replace the question", async () => {
    const { question } = await fresh();
    const first = await propose(question.id, "rephrase", rephrased, question.revisionId);
    const second = await propose(question.id, "add_explanation", explained, question.revisionId);
    const results = await Promise.allSettled([
      acceptRewrite(db, alice.id, first.id, { confirmed: true, as: "revision" }),
      acceptRewrite(db, alice.id, second.id, { confirmed: true, as: "revision" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect(lost).toMatchObject({ reason: { status: 409, code: "stale_proposal" } });
    expect((await getQuestion(db, alice.id, question.id)).revisionNumber).toBe(2);
  });

  it("refuses to replace a question that changed since the proposal, but can still add it as new", async () => {
    const { question } = await fresh();
    const proposal = await propose(question.id, "rephrase", rephrased, question.revisionId);
    await updateQuestion(db, alice.id, question.id, { prompt: "What is 3 + 4? (edited)" });
    await expect(
      acceptRewrite(db, alice.id, proposal.id, { confirmed: true, as: "revision" }),
    ).rejects.toMatchObject({ status: 409, code: "stale_proposal" });
    const added = await acceptRewrite(db, alice.id, proposal.id, {
      confirmed: true,
      as: "new_question",
    });
    expect(added.question.prompt).toBe("Work out 3 plus 4.");
  });

  it("cannot accept a dismissed proposal, and another user cannot touch it", async () => {
    const { question } = await fresh();
    const proposal = await propose(question.id, "rephrase", rephrased, question.revisionId);
    await expect(
      acceptRewrite(db, bob.id, proposal.id, { confirmed: true, as: "revision" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(dismissRewrite(db, bob.id, proposal.id)).rejects.toMatchObject({ status: 404 });
    await dismissRewrite(db, alice.id, proposal.id);
    await dismissRewrite(db, alice.id, proposal.id);
    await expect(
      acceptRewrite(db, alice.id, proposal.id, { confirmed: true, as: "revision" }),
    ).rejects.toMatchObject({ code: "already_resolved" });
    const [row] = await db
      .select()
      .from(questionRewrites)
      .where(eq(questionRewrites.id, proposal.id));
    expect(row!.status).toBe("dismissed");
  });
});
