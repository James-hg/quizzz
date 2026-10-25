import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const storageDir = await mkdtemp(path.join(os.tmpdir(), "quizzz-review-storage-"));
const samplesDir = await mkdtemp(path.join(os.tmpdir(), "quizzz-review-samples-"));
process.env.STORAGE_DIR = storageDir;
process.env.SAMPLES_DIR = samplesDir;
process.env.AUTH_RATE_LIMIT_MAX = "1000";

import { PATCH as questionPatch } from "@/app/api/questions/[questionId]/route";
import { POST as loadPost } from "@/app/api/samples/[language]/load/route";
import { POST as sessionsPost } from "@/app/api/sessions/route";
import { listQuestionSetsWithCounts } from "@/server/content/overview";
import { getDb } from "@/server/db";
import { questionRevisions, questions } from "@/server/db/schema";
import { authRequest } from "@/test/auth-helpers";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { listLoadedSamples } from "./loader";
import { listAvailableSamples } from "./service";

// An unchecked sample: no provenance anywhere, exactly like the shipped drafts.
const UNCHECKED = `format: 1
course:
  title: Review test course
  subject: Test subject
  language: python
questions:
  - { id: q1, type: mcq_single, prompt: First test prompt, options: [{ id: a, text: x }, { id: b, text: y }], correctOptionIds: [a] }
  - { id: q2, type: mcq_single, prompt: Second test prompt, options: [{ id: a, text: x }, { id: b, text: y }], correctOptionIds: [b] }
  - { id: q3, type: short_answer, prompt: Third test prompt, accepted: ["z"] }
`;

const db = getDb();
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  await mkdir(path.join(samplesDir, "python"));
  await writeFile(path.join(samplesDir, "python", "course.yaml"), UNCHECKED);
  alice = await signUpUser(db);
  bob = await signUpUser(db);
});

afterAll(async () => {
  await deleteUsers(db, [alice.id, bob.id]);
  await rm(storageDir, { recursive: true, force: true });
  await rm(samplesDir, { recursive: true, force: true });
});

async function call(
  handler: unknown,
  options: { method?: string; body?: unknown; as?: TestUser; params?: Record<string, string> } = {},
) {
  const who = options.as ?? alice;
  const request = authRequest("/x", {
    method: options.method ?? "POST",
    body: options.body,
    cookie: who.cookie,
  });
  const response = await (
    handler as (r: Request, c: { params: Promise<never> }) => Promise<Response>
  )(request, { params: Promise.resolve((options.params ?? {}) as never) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe("exploring an unchecked sample", () => {
  let courseId: string;
  let setId: string;

  it("lists the sample as an unchecked draft", async () => {
    expect(await listAvailableSamples()).toEqual([
      {
        language: "python",
        title: "Review test course",
        subject: "Test subject",
        sectionCount: 0,
        questionCount: 3,
        checkedQuestionCount: 0,
      },
    ]);
    expect(await listLoadedSamples(db, alice.id)).toEqual({});
  });

  it("loads from the sample route and remembers the copy", async () => {
    const loaded = await call(loadPost, { params: { language: "python" } });
    expect(loaded.status).toBe(201);
    expect(loaded.body).toMatchObject({
      questionCount: 3,
      needsReviewCount: 3,
      alreadyLoaded: false,
    });
    courseId = loaded.body.courseId;
    setId = loaded.body.questionSetId;
    expect(await listLoadedSamples(db, alice.id)).toEqual({
      python: { courseId, questionSetId: setId },
    });
    expect(await listLoadedSamples(db, bob.id)).toEqual({});
  });

  it("counts every question as needing review, so none can be practised", async () => {
    const [row] = await listQuestionSetsWithCounts(db, alice.id, courseId);
    expect(row).toMatchObject({
      origin: "sample",
      questionCount: 3,
      playableCount: 0,
      needsReviewCount: 3,
      noAnswerCount: 0,
      excludedCount: 0,
    });
  });

  it("refuses to start practice and says why", async () => {
    const started = await call(sessionsPost, { body: { questionSetId: setId, mode: "quiz" } });
    expect(started.status).toBe(409);
    expect(started.body.error).toMatchObject({
      code: "no_playable_questions",
      details: { total: 3, playable: 0, needsReview: 3, noAnswer: 0, excluded: 0 },
    });
  });

  it("starts with exactly the question the owner approves", async () => {
    const [first] = await db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.questionSetId, setId))
      .orderBy(asc(questions.position));

    const approved = await call(questionPatch, {
      method: "PATCH",
      body: { approve: true },
      params: { questionId: first!.id },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.question).toMatchObject({
      evidenceStatus: "human_reviewed",
      origin: "sample",
    });

    const [row] = await listQuestionSetsWithCounts(db, alice.id, courseId);
    expect(row).toMatchObject({ playableCount: 1, needsReviewCount: 2 });

    const started = await call(sessionsPost, { body: { questionSetId: setId, mode: "quiz" } });
    expect(started.status).toBe(201);
    expect(started.body.session.progress.total).toBe(1);
    expect(started.body.session.current.questionId).toBe(first!.id);

    // Unapproved questions never entered the session.
    const [revision] = await db
      .select({ prompt: questionRevisions.prompt })
      .from(questionRevisions)
      .where(eq(questionRevisions.questionId, first!.id))
      .orderBy(asc(questionRevisions.revisionNumber));
    expect(revision?.prompt).toBe("First test prompt");
  });

  it("returns the same copy when loaded again, with the real remaining count", async () => {
    const again = await call(loadPost, { params: { language: "python" } });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      alreadyLoaded: true,
      courseId,
      questionSetId: setId,
      questionCount: 3,
      needsReviewCount: 2,
    });
  });

  it("gives another user their own, separate, unreviewed copy", async () => {
    const mine = await call(loadPost, { params: { language: "python" }, as: bob });
    expect(mine.status).toBe(201);
    expect(mine.body.courseId).not.toBe(courseId);
    expect(mine.body.needsReviewCount).toBe(3);
  });
});
