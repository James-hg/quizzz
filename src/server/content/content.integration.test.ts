import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DELETE as courseDelete,
  GET as courseGet,
  PATCH as coursePatch,
} from "@/app/api/courses/[courseId]/route";
import { GET as setsGet, POST as setsPost } from "@/app/api/courses/[courseId]/question-sets/route";
import { GET as coursesGet, POST as coursesPost } from "@/app/api/courses/route";
import { PUT as orderPut } from "@/app/api/question-sets/[setId]/questions/order/route";
import {
  GET as questionsGet,
  POST as questionsPost,
} from "@/app/api/question-sets/[setId]/questions/route";
import {
  DELETE as setDelete,
  GET as setGet,
  PATCH as setPatch,
} from "@/app/api/question-sets/[setId]/route";
import { POST as excludePost } from "@/app/api/questions/[questionId]/exclude/route";
import { GET as revisionsGet } from "@/app/api/questions/[questionId]/revisions/route";
import { POST as restorePost } from "@/app/api/questions/[questionId]/restore/route";
import {
  DELETE as questionDelete,
  GET as questionGet,
  PATCH as questionPatch,
} from "@/app/api/questions/[questionId]/route";
import { POST as shufflePost } from "@/app/api/questions/[questionId]/shuffle-options/route";
import { authRequest } from "@/test/auth-helpers";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { getDb } from "@/server/db";
import { insertAttempt } from "@/server/db/repositories/attempts";
import { attempts, courses, questionRevisions, questions, studySessions } from "@/server/db/schema";
import { listPlayableQuestionIds, shuffleOptions, shuffled } from "./questions";

process.env.AUTH_RATE_LIMIT_MAX = "1000";

const db = getDb();
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  alice = await signUpUser(db);
  bob = await signUpUser(db);
});

afterAll(async () => {
  await deleteUsers(db, [alice.id, bob.id]);
});

type Handler = (request: Request, ctx: { params: Promise<never> }) => Promise<Response>;

async function call(
  handler: unknown,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    as?: TestUser | null;
    params?: Record<string, string>;
  } = {},
) {
  const who = options.as === undefined ? alice : options.as;
  const request = authRequest(path, {
    method: options.method,
    body: options.body,
    cookie: who?.cookie,
  });
  const response = await (handler as Handler)(request, {
    params: Promise.resolve((options.params ?? {}) as never),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const mcq = (overrides: Record<string, unknown> = {}) => ({
  type: "mcq_single",
  prompt: "What does len([1, 2]) return?",
  options: [
    { id: "a", text: "1" },
    { id: "b", text: "2" },
    { id: "c", text: "3" },
  ],
  correctOptionIds: ["b"],
  ...overrides,
});

async function makeCourse(as: TestUser = alice) {
  const res = await call(coursesPost, "/api/courses", {
    as,
    body: { title: "CS 101", subject: "Intro", language: "python", examDate: "2026-12-15" },
  });
  expect(res.status).toBe(201);
  return res.body.course as { id: string };
}

async function makeSet(courseId: string, as: TestUser = alice) {
  const res = await call(setsPost, "/api/x", {
    as,
    body: { title: "Week 1" },
    params: { courseId },
  });
  expect(res.status).toBe(201);
  return res.body.questionSet as { id: string };
}

async function makeQuestion(setId: string, body: unknown = mcq(), as: TestUser = alice) {
  const res = await call(questionsPost, "/api/x", { as, body, params: { setId } });
  expect(res.status).toBe(201);
  return res.body.question as { id: string; revisionId: string; revisionNumber: number };
}

/** An attempt made against the question's current revision. */
async function attemptOn(
  question: { id: string; revisionId: string },
  courseId: string,
  setId: string,
) {
  const [session] = await db
    .insert(studySessions)
    .values({ userId: alice.id, courseId, questionSetId: setId, mode: "quiz" })
    .returning();
  return insertAttempt(db, {
    sessionId: session!.id,
    userId: alice.id,
    questionId: question.id,
    questionRevisionId: question.revisionId,
    response: { kind: "options", selectedOptionIds: ["b"] },
    isCorrect: true,
    gradingOutcome: "correct",
    idempotencyKey: randomUUID(),
    startedAt: new Date(),
  });
}

describe("courses and question sets", () => {
  it("creates, lists, updates, and fetches a course", async () => {
    const course = await makeCourse();
    const list = await call(coursesGet, "/api/courses");
    expect(list.body.courses.map((c: { id: string }) => c.id)).toContain(course.id);

    const updated = await call(coursePatch, "/api/x", {
      method: "PATCH",
      body: { title: "CS 102", language: null },
      params: { courseId: course.id },
    });
    expect(updated.body.course).toMatchObject({ title: "CS 102", language: null });
    const got = await call(courseGet, "/api/x", { params: { courseId: course.id } });
    expect(got.body.course.title).toBe("CS 102");
  });

  it("rejects an invalid language and a malformed date with 400", async () => {
    const bad = await call(coursesPost, "/api/courses", {
      body: { title: "x", subject: "y", language: "cobol" },
    });
    expect(bad.status).toBe(400);
    const date = await call(coursesPost, "/api/courses", {
      body: { title: "x", subject: "y", examDate: "tomorrow" },
    });
    expect(date.status).toBe(400);
  });

  it("creates, renames, lists, and deletes a question set", async () => {
    const course = await makeCourse();
    const set = await makeSet(course.id);
    const renamed = await call(setPatch, "/api/x", {
      method: "PATCH",
      body: { title: "Week 2" },
      params: { setId: set.id },
    });
    expect(renamed.body.questionSet.title).toBe("Week 2");
    const list = await call(setsGet, "/api/x", { params: { courseId: course.id } });
    expect(list.body.questionSets).toHaveLength(1);
    expect(
      (await call(setDelete, "/api/x", { method: "DELETE", params: { setId: set.id } })).status,
    ).toBe(204);
    expect((await call(setGet, "/api/x", { params: { setId: set.id } })).status).toBe(404);
  });

  it("deletes a never-attempted course with its content", async () => {
    const course = await makeCourse();
    const set = await makeSet(course.id);
    const q = await makeQuestion(set.id);
    const res = await call(courseDelete, "/api/x", {
      method: "DELETE",
      params: { courseId: course.id },
    });
    expect(res.status).toBe(204);
    expect(await db.select().from(courses).where(eq(courses.id, course.id))).toHaveLength(0);
    expect(await db.select().from(questions).where(eq(questions.id, q.id))).toHaveLength(0);
  });

  it("refuses to delete a course or set that has attempts (409 has_history)", async () => {
    const course = await makeCourse();
    const set = await makeSet(course.id);
    const q = await makeQuestion(set.id);
    await attemptOn(q, course.id, set.id);

    const setRes = await call(setDelete, "/api/x", { method: "DELETE", params: { setId: set.id } });
    expect(setRes.status).toBe(409);
    expect(setRes.body.error.code).toBe("has_history");
    const courseRes = await call(courseDelete, "/api/x", {
      method: "DELETE",
      params: { courseId: course.id },
    });
    expect(courseRes.status).toBe(409);
    expect(await db.select().from(attempts).where(eq(attempts.questionId, q.id))).toHaveLength(1);
  });
});

describe("questions", () => {
  it("creates a question with revision 1 and returns the answer key to its owner", async () => {
    const set = await makeSet((await makeCourse()).id);
    const q = await makeQuestion(set.id);
    const got = await call(questionGet, "/api/x", { params: { questionId: q.id } });
    expect(got.body.question).toMatchObject({
      revisionNumber: 1,
      type: "mcq_single",
      answerKey: { kind: "options", correctOptionIds: ["b"] },
      origin: "original",
      status: "active",
    });
  });

  it("marks an owner-written question with an answer as reviewed, ticked or not", async () => {
    const set = await makeSet((await makeCourse()).id);
    const plain = await call(questionsPost, "/api/x", { body: mcq(), params: { setId: set.id } });
    expect(plain.body.question.evidenceStatus).toBe("human_reviewed");
    expect(plain.body.question.origin).toBe("original");
    const ticked = await call(questionsPost, "/api/x", {
      body: mcq({ approve: true }),
      params: { setId: set.id },
    });
    expect(ticked.body.question.evidenceStatus).toBe("human_reviewed");
  });

  it("rejects MCQ with 0 or 2+ correct options and duplicate option ids", async () => {
    const set = await makeSet((await makeCourse()).id);
    const post = (body: unknown) =>
      call(questionsPost, "/api/x", { body, params: { setId: set.id } });
    expect((await post(mcq({ correctOptionIds: [] }))).status).toBe(400);
    expect((await post(mcq({ correctOptionIds: ["a", "b"] }))).status).toBe(400);
    const dup = mcq({
      options: [
        { id: "a", text: "1" },
        { id: "a", text: "2" },
      ],
      correctOptionIds: ["a"],
    });
    expect((await post(dup)).status).toBe(400);
    expect((await post({ type: "short_answer", prompt: "Q", accepted: [] })).status).toBe(400);
  });

  it("editing a question with attempts creates revision N+1 and keeps the old grading", async () => {
    const course = await makeCourse();
    const set = await makeSet(course.id);
    const q = await makeQuestion(set.id);
    const attempt = await attemptOn(q, course.id, set.id);

    const patched = await call(questionPatch, "/api/x", {
      method: "PATCH",
      body: { correctOptionIds: ["c"], prompt: "Edited prompt" },
      params: { questionId: q.id },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.question).toMatchObject({
      revisionNumber: 2,
      prompt: "Edited prompt",
      answerKey: { kind: "options", correctOptionIds: ["c"] },
    });

    const [stored] = await db.select().from(attempts).where(eq(attempts.id, attempt.id));
    expect(stored).toMatchObject({
      questionRevisionId: q.revisionId,
      isCorrect: true,
      gradingOutcome: "correct",
    });
    const [old] = await db
      .select()
      .from(questionRevisions)
      .where(eq(questionRevisions.id, q.revisionId));
    expect(old).toMatchObject({ revisionNumber: 1, prompt: "What does len([1, 2]) return?" });

    const revisions = await call(revisionsGet, "/api/x", { params: { questionId: q.id } });
    expect(
      revisions.body.revisions.map((r: { revisionNumber: number }) => r.revisionNumber),
    ).toEqual([1, 2]);
  });

  it("validates a PATCH against the whole question and reports changing type clearly", async () => {
    const set = await makeSet((await makeCourse()).id);
    const q = await makeQuestion(set.id);
    const bad = await call(questionPatch, "/api/x", {
      method: "PATCH",
      body: { correctOptionIds: ["a", "b"] },
      params: { questionId: q.id },
    });
    expect(bad.status).toBe(400);
    const typeChange = await call(questionPatch, "/api/x", {
      method: "PATCH",
      body: { type: "short_answer" },
      params: { questionId: q.id },
    });
    expect(typeChange.status).toBe(400);
    const ok = await call(questionPatch, "/api/x", {
      method: "PATCH",
      body: { type: "short_answer", accepted: ["2"] },
      params: { questionId: q.id },
    });
    expect(ok.body.question).toMatchObject({ type: "short_answer", revisionNumber: 2 });
  });

  it("hard-deletes a never-attempted question but not an attempted one", async () => {
    const course = await makeCourse();
    const set = await makeSet(course.id);
    const fresh = await makeQuestion(set.id);
    const used = await makeQuestion(set.id);
    await attemptOn(used, course.id, set.id);

    const ok = await call(questionDelete, "/api/x", {
      method: "DELETE",
      params: { questionId: fresh.id },
    });
    expect(ok.status).toBe(204);
    const blocked = await call(questionDelete, "/api/x", {
      method: "DELETE",
      params: { questionId: used.id },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("has_history");
  });

  it("excludes and restores; excluded questions leave new sessions", async () => {
    const course = await makeCourse();
    const set = await makeSet(course.id);
    const q1 = await makeQuestion(set.id);
    const q2 = await makeQuestion(set.id);
    await attemptOn(q1, course.id, set.id);

    const excluded = await call(excludePost, "/api/x", {
      method: "POST",
      params: { questionId: q1.id },
    });
    expect(excluded.body.question.status).toBe("excluded");
    expect(await listPlayableQuestionIds(db, set.id)).toEqual([q2.id]);

    const restored = await call(restorePost, "/api/x", {
      method: "POST",
      params: { questionId: q1.id },
    });
    expect(restored.body.question.status).toBe("active");
    expect(await listPlayableQuestionIds(db, set.id)).toEqual([q1.id, q2.id]);
  });

  it("reorders questions and rejects an incomplete id list", async () => {
    const set = await makeSet((await makeCourse()).id);
    const q1 = await makeQuestion(set.id);
    const q2 = await makeQuestion(set.id);
    const q3 = await makeQuestion(set.id);

    const ok = await call(orderPut, "/api/x", {
      method: "PUT",
      body: { questionIds: [q3.id, q1.id, q2.id] },
      params: { setId: set.id },
    });
    expect(ok.body.questions.map((q: { id: string }) => q.id)).toEqual([q3.id, q1.id, q2.id]);
    const bad = await call(orderPut, "/api/x", {
      method: "PUT",
      body: { questionIds: [q3.id, q1.id] },
      params: { setId: set.id },
    });
    expect(bad.status).toBe(400);
    const list = await call(questionsGet, "/api/x", { params: { setId: set.id } });
    expect(list.body.questions.map((q: { position: number }) => q.position)).toEqual([0, 1, 2]);
  });

  it("stores a shuffled option order as a new revision without changing the answer key", async () => {
    const set = await makeSet((await makeCourse()).id);
    const q = await makeQuestion(set.id);
    const res = await call(shufflePost, "/api/x", { method: "POST", params: { questionId: q.id } });
    expect(res.status).toBe(200);
    expect(res.body.question.revisionNumber).toBe(2);
    expect(res.body.question.answerKey).toEqual({ kind: "options", correctOptionIds: ["b"] });
    expect(res.body.question.options.map((o: { id: string }) => o.id).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);

    const reverse = () => 0;
    const again = await shuffleOptions(db, alice.id, q.id, reverse);
    expect(again.revisionNumber).toBe(3);
    expect(again.options.map((o) => o.id).sort()).toEqual(["a", "b", "c"]);

    const text = await makeQuestion(set.id, { type: "short_answer", prompt: "Q", accepted: ["x"] });
    const bad = await call(shufflePost, "/api/x", {
      method: "POST",
      params: { questionId: text.id },
    });
    expect(bad.status).toBe(400);
  });

  it("shuffled is a permutation and deterministic for a given rng", () => {
    const items = [1, 2, 3, 4, 5];
    const rng = () => 0.5;
    expect(shuffled(items, rng)).toEqual(shuffled(items, rng));
    expect([...shuffled(items, rng)].sort()).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("access control", () => {
  it("returns 401 without a session", async () => {
    expect((await call(coursesGet, "/api/courses", { as: null })).status).toBe(401);
    const q = await makeQuestion((await makeSet((await makeCourse()).id)).id);
    const res = await call(questionGet, "/api/x", { as: null, params: { questionId: q.id } });
    expect(res.status).toBe(401);
  });

  it("returns 404 for another user's ids on every route", async () => {
    const course = await makeCourse();
    const set = await makeSet(course.id);
    const q = await makeQuestion(set.id);
    const p = { courseId: course.id, setId: set.id, questionId: q.id };
    const asBob = { as: bob };

    const cases: [string, unknown, Record<string, unknown>][] = [
      ["course GET", courseGet, { params: { courseId: p.courseId } }],
      [
        "course PATCH",
        coursePatch,
        { method: "PATCH", body: { title: "x" }, params: { courseId: p.courseId } },
      ],
      ["course DELETE", courseDelete, { method: "DELETE", params: { courseId: p.courseId } }],
      ["sets GET", setsGet, { params: { courseId: p.courseId } }],
      ["sets POST", setsPost, { body: { title: "x" }, params: { courseId: p.courseId } }],
      ["set GET", setGet, { params: { setId: p.setId } }],
      [
        "set PATCH",
        setPatch,
        { method: "PATCH", body: { title: "x" }, params: { setId: p.setId } },
      ],
      ["set DELETE", setDelete, { method: "DELETE", params: { setId: p.setId } }],
      ["questions GET", questionsGet, { params: { setId: p.setId } }],
      ["questions POST", questionsPost, { body: mcq(), params: { setId: p.setId } }],
      [
        "order PUT",
        orderPut,
        { method: "PUT", body: { questionIds: [p.questionId] }, params: { setId: p.setId } },
      ],
      ["question GET", questionGet, { params: { questionId: p.questionId } }],
      [
        "question PATCH",
        questionPatch,
        { method: "PATCH", body: { prompt: "x" }, params: { questionId: p.questionId } },
      ],
      [
        "question DELETE",
        questionDelete,
        { method: "DELETE", params: { questionId: p.questionId } },
      ],
      ["revisions GET", revisionsGet, { params: { questionId: p.questionId } }],
      ["exclude POST", excludePost, { method: "POST", params: { questionId: p.questionId } }],
      ["restore POST", restorePost, { method: "POST", params: { questionId: p.questionId } }],
      ["shuffle POST", shufflePost, { method: "POST", params: { questionId: p.questionId } }],
    ];

    for (const [name, handler, options] of cases) {
      const res = await call(handler, "/api/x", { ...asBob, ...options } as never);
      expect(res.status, name).toBe(404);
    }

    // Bob's own list stays empty and Alice's data is untouched.
    const bobCourses = await call(coursesGet, "/api/courses", { as: bob });
    expect(bobCourses.body.courses).toEqual([]);
    const still = await call(questionGet, "/api/x", { params: { questionId: q.id } });
    expect(still.body.question.revisionNumber).toBe(1);
  });

  it("treats a malformed id as 404, not a server error", async () => {
    const res = await call(courseGet, "/api/x", { params: { courseId: "not-a-uuid" } });
    expect(res.status).toBe(404);
  });
});
