import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as todayGet } from "@/app/api/today/route";
import { POST as answerPost } from "@/app/api/sessions/[sessionId]/answers/route";
import { POST as completePost } from "@/app/api/sessions/[sessionId]/complete/route";
import { GET as sessionGet } from "@/app/api/sessions/[sessionId]/route";
import { GET as resultsGet } from "@/app/api/sessions/[sessionId]/results/route";
import { POST as sessionsPost } from "@/app/api/sessions/route";
import { createCourse } from "@/server/content/courses";
import { createQuestionSet } from "@/server/content/question-sets";
import { createQuestion } from "@/server/content/questions";
import { getDb } from "@/server/db";
import { addRevision } from "@/server/db/repositories/questions";
import { attempts, helpEvents, questions, reviewStates, studySessions } from "@/server/db/schema";
import { contentToRevision } from "@/lib/schemas";
import { startOrResumeCourseSession } from "@/server/sessions/course-session";
import { assertHelpAllowed } from "@/server/sessions/guards";
import { completeSession, pauseSession, resumeSession } from "@/server/sessions/service";
import { submitAnswer } from "@/server/sessions/answers";
import { call } from "@/test/api";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";

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

const SECRET_EXPLANATION = "because-secret-planner-explanation";
const key = () => `key-${randomUUID()}`;

async function addQuestion(setId: string, prompt: string, approve = true) {
  return createQuestion(
    db,
    alice.id,
    setId,
    {
      type: "mcq_single",
      prompt,
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      correctOptionIds: ["b"],
      explanation: SECRET_EXPLANATION,
    },
    approve,
  );
}

/** A course with `sizes.length` question sets holding that many playable questions each. */
async function makeCourse(sizes: number[], title = "Planner course") {
  const course = await createCourse(db, alice.id, { title, subject: "S" });
  const sets = [];
  const all = [];
  for (const [i, size] of sizes.entries()) {
    const set = await createQuestionSet(db, alice.id, course.id, `Set ${i + 1}`);
    sets.push(set);
    for (let n = 0; n < size; n++)
      all.push(await addQuestion(set.id, `S${i + 1} question ${n + 1}`));
  }
  return { course, sets, questions: all };
}

/** Marks questions as due now, as the scheduler would after earlier independent successes. */
async function makeDue(questionIds: string[], daysAgo = 2) {
  for (const [i, questionId] of questionIds.entries()) {
    await db.insert(reviewStates).values({
      userId: alice.id,
      questionId,
      state: "reviewing",
      stepIndex: 1,
      nextDueAt: new Date(Date.now() - (daysAgo + i) * 24 * 3600 * 1000),
      lastIndependentSuccessAt: new Date(Date.now() - 10 * 24 * 3600 * 1000),
      distinctSuccessDays: 1,
    });
  }
}

const startCourse = (
  courseId: string,
  mode: "review" | "exam",
  timeBudgetMinutes: number,
  as: TestUser | null = alice,
) => call(sessionsPost, "/api/sessions", as, { body: { courseId, mode, timeBudgetMinutes } });
const today = (query: string, as: TestUser | null = alice) =>
  call(todayGet, `/api/today${query}`, as);
const answer = (
  sessionId: string,
  questionId: string,
  response: unknown,
  idempotencyKey = key(),
  pass?: 1 | 2,
) =>
  call(answerPost, "/api/x", alice, {
    body: { questionId, response, idempotencyKey, ...(pass ? { pass } : {}) },
    params: { sessionId },
  });
const view = (sessionId: string) => call(sessionGet, "/api/x", alice, { params: { sessionId } });
const results = (sessionId: string, as: TestUser | null = alice) =>
  call(resultsGet, "/api/x", as, { params: { sessionId } });
const complete = (sessionId: string) =>
  call(completePost, "/api/x", alice, { body: {}, params: { sessionId } });
const choose = (...ids: string[]) => ({ kind: "options", selectedOptionIds: ids });
const t0 = new Date("2026-03-02T15:00:00Z");
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
const submit = (sessionId: string, questionId: string, ids: string[], now: Date) =>
  submitAnswer(
    db,
    alice.id,
    sessionId,
    {
      questionId,
      response: { kind: "options", selectedOptionIds: ids },
      idempotencyKey: key(),
      pass: 1,
    },
    now,
  );

describe("GET /api/today", () => {
  it("recommends a short session with reasons and budget options, and no question content", async () => {
    const { course } = await makeCourse([6]);
    const r = await today(`?courseId=${course.id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      course: { id: course.id, title: "Planner course" },
      recommendedBudgetMinutes: 5,
      budgetOptions: [5, 10, 20],
      availableCount: 6,
      dueCount: 0,
      newCount: 6,
    });
    expect(r.body.options).toEqual([
      { minutes: 5, questionCount: 2, limitedBy: "budget" },
      { minutes: 10, questionCount: 5, limitedBy: "budget" },
      { minutes: 20, questionCount: 6, limitedBy: "content" },
    ]);
    expect(r.body.reasons.join(" ")).toMatch(/Nothing is due for review today/);
    expect(r.text).not.toMatch(/question 1|"B"|correctOptionIds|secret/i);
  });

  it("recommends the shortest budget that fits everything due, and says what was deferred", async () => {
    const { course, questions: qs } = await makeCourse([30]);
    await makeDue(qs.slice(0, 3).map((q) => q.id));
    const r = await today(`?courseId=${course.id}`);
    expect(r.body.dueCount).toBe(3);
    expect(r.body.recommendedBudgetMinutes).toBe(10);
    expect(r.body.estimatedDurationMinutes).toBeGreaterThanOrEqual(5);
    expect(r.body.reasons.join(" ")).toMatch(/3 questions are due for review/);

    const many = await makeCourse([60], "Backlog");
    await makeDue(many.questions.slice(0, 50).map((q) => q.id));
    const backlog = await today(`?courseId=${many.course.id}`);
    // The scheduler offers at most 20 a day; the rest are deferred, not failed.
    expect(backlog.body.dueCount).toBe(20);
    expect(backlog.body.deferredDueCount).toBe(30);
    expect(backlog.body.recommendedBudgetMinutes).toBe(20);
    expect(backlog.body.limitedBy).toBe("budget");
  });

  it("validates the course id, requires sign-in, and hides other users' courses", async () => {
    const { course } = await makeCourse([2]);
    expect((await today(`?courseId=${course.id}`, null)).status).toBe(401);
    expect((await today("")).status).toBe(400);
    expect((await today("?courseId=not-a-uuid")).status).toBe(400);
    expect((await today(`?courseId=${course.id}&courseId=${randomUUID()}`)).status).toBe(400);
    expect((await today(`?courseId=${randomUUID()}`)).status).toBe(404);
    expect((await today(`?courseId=${course.id}`, bob)).status).toBe(404);
  });

  it("reports an empty course honestly", async () => {
    const course = await createCourse(db, alice.id, { title: "Empty", subject: "S" });
    const r = await today(`?courseId=${course.id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ availableCount: 0, estimatedDurationMinutes: 0 });
    expect(r.body.reasons).toEqual(["There are no playable questions in this course yet."]);
  });

  it("points at a review session that is already running", async () => {
    const { course } = await makeCourse([4]);
    const started = await startCourse(course.id, "review", 5);
    const r = await today(`?courseId=${course.id}`);
    expect(r.body.liveSessionId).toBe(started.body.session.id);
  });
});

describe("planned review sessions", () => {
  it("fits a 5-minute session to what is due and says why", async () => {
    const { course, questions: qs } = await makeCourse([60]);
    await makeDue(qs.slice(0, 50).map((q) => q.id));
    const r = await startCourse(course.id, "review", 5);
    expect(r.status).toBe(201);
    expect(r.body.session).toMatchObject({
      mode: "review",
      revealMode: "requeue",
      timeBudgetMinutes: 5,
      questionSetId: null,
    });
    expect(r.body.session.progress.total).toBe(2); // one due question plus the reserved new slot
    expect(r.body.plan.limitedBy).toBe("budget");
    expect(r.body.plan.reasons[0]).toMatch(/1 of your 20 due questions fit in 5 minutes/);
  });

  it("keeps a new-learning slot when new questions exist, even with a large backlog", async () => {
    const { course, questions: qs } = await makeCourse([40]);
    await makeDue(qs.slice(0, 20).map((q) => q.id));
    const r = await startCourse(course.id, "review", 10);
    const ids = new Set(r.body.session.items.map((i: { questionId: string }) => i.questionId));
    const dueIds = new Set(qs.slice(0, 20).map((q) => q.id));
    const fresh = [...ids].filter((id) => !dueIds.has(id as string));
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    expect(r.body.plan.reasons.join(" ")).toMatch(/kept for new questions/);
  });

  it("resumes the same session without changing its budget or questions", async () => {
    const { course } = await makeCourse([12]);
    const first = await startCourse(course.id, "review", 5);
    const again = await startCourse(course.id, "review", 20);
    expect(again.status).toBe(200);
    expect(again.body.session.id).toBe(first.body.session.id);
    expect(again.body.session.timeBudgetMinutes).toBe(5);
    expect(again.body.session.items.map((i: { questionId: string }) => i.questionId)).toEqual(
      first.body.session.items.map((i: { questionId: string }) => i.questionId),
    );
    expect(again.body.plan).toBeUndefined();
  });

  it("creates only one session when several starts race", async () => {
    const { course } = await makeCourse([8]);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => startCourse(course.id, "review", 10)),
    );
    expect(new Set(results.map((r) => r.body.session.id)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const live = await db
      .select({ id: studySessions.id })
      .from(studySessions)
      .where(and(eq(studySessions.courseId, course.id), eq(studySessions.userId, alice.id)));
    expect(live).toHaveLength(1);
  });

  it("allows a live review and a live exam for the same course, but not two of a kind", async () => {
    const { course } = await makeCourse([6]);
    const review = await startCourse(course.id, "review", 5);
    const exam = await startCourse(course.id, "exam", 10);
    expect(review.body.session.id).not.toBe(exam.body.session.id);
    expect((await startCourse(course.id, "exam", 5)).body.session.id).toBe(exam.body.session.id);
  });

  it("lets a finished session be followed by a new one", async () => {
    const { course } = await makeCourse([6]);
    const first = await startCourse(course.id, "review", 5);
    await complete(first.body.session.id);
    const next = await startCourse(course.id, "review", 5);
    expect(next.status).toBe(201);
    expect(next.body.session.id).not.toBe(first.body.session.id);
  });

  it("retries a wrong answer once, as in requeue mode", async () => {
    const { course } = await makeCourse([6]);
    const { body } = await startCourse(course.id, "review", 10);
    const id = body.session.id;
    const first = body.session.items[0].questionId;
    const wrong = await answer(id, first, choose("a"));
    expect(wrong.body.result).toMatchObject({ disclosure: "verdict", outcome: "incorrect" });
    expect(wrong.body.requeued).toBe(true);
    expect(wrong.text).not.toContain(SECRET_EXPLANATION);
    const retry = await answer(id, first, choose("b"), key(), 2);
    expect(retry.body.result).toMatchObject({ pass: 2, outcome: "correct", disclosure: "full" });
  });
});

describe("start validation and ownership", () => {
  it("rejects bodies that try to override the rules of a course mode", async () => {
    const { course, sets } = await makeCourse([3]);
    const post = (body: unknown) => call(sessionsPost, "/api/sessions", alice, { body });
    expect(
      (
        await post({
          courseId: course.id,
          mode: "review",
          timeBudgetMinutes: 5,
          revealMode: "each",
        })
      ).status,
    ).toBe(400);
    expect(
      (await post({ courseId: course.id, mode: "exam", timeBudgetMinutes: 5, revealMode: "each" }))
        .status,
    ).toBe(400);
    expect(
      (
        await post({
          courseId: course.id,
          questionSetId: sets[0]!.id,
          mode: "review",
          timeBudgetMinutes: 5,
        })
      ).status,
    ).toBe(400);
    expect((await post({ courseId: course.id, mode: "review", timeBudgetMinutes: 7 })).status).toBe(
      400,
    );
    expect((await post({ courseId: course.id, mode: "review" })).status).toBe(400);
    expect((await post({ courseId: course.id, mode: "quiz", timeBudgetMinutes: 5 })).status).toBe(
      400,
    );
    expect((await post({ mode: "review", timeBudgetMinutes: 5 })).status).toBe(400);
  });

  it("still starts the original question-set quiz", async () => {
    const { sets } = await makeCourse([3]);
    const quiz = await call(sessionsPost, "/api/sessions", alice, {
      body: { questionSetId: sets[0]!.id, mode: "quiz" },
    });
    expect(quiz.status).toBe(201);
    expect(quiz.body.session).toMatchObject({
      mode: "quiz",
      questionSetId: sets[0]!.id,
      timeBudgetMinutes: null,
      revealMode: "each",
    });
  });

  it("hides another user's course", async () => {
    const { course } = await makeCourse([3]);
    expect((await startCourse(course.id, "review", 5, bob)).status).toBe(404);
    expect((await startCourse(randomUUID(), "review", 5)).status).toBe(404);
    expect((await startCourse(course.id, "review", 5, null)).status).toBe(401);
  });

  it("explains why when a course has nothing to practise", async () => {
    const course = await createCourse(db, alice.id, { title: "Unreviewed", subject: "S" });
    const set = await createQuestionSet(db, alice.id, course.id, "Draft");
    await addQuestion(set.id, "Not approved", false); // an owner question with an answer is reviewed
    const unreviewed = await createQuestion(
      db,
      alice.id,
      set.id,
      {
        type: "mcq_single",
        prompt: "x",
        options: [
          { id: "a", text: "1" },
          { id: "b", text: "2" },
        ],
        correctOptionIds: ["a"],
      },
      false,
    );
    await db.update(questions).set({ status: "excluded" }).where(eq(questions.id, unreviewed.id));
    await db
      .update(questions)
      .set({ status: "excluded" })
      .where(eq(questions.questionSetId, set.id));
    const r = await startCourse(course.id, "review", 5);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: "no_playable_questions",
      details: { total: 2, playable: 0, excluded: 2 },
    });
  });

  it("never plans questions that cannot be practised", async () => {
    const { course, sets, questions: qs } = await makeCourse([3]);
    await db.update(questions).set({ status: "excluded" }).where(eq(questions.id, qs[0]!.id));
    const hidden = await addQuestion(sets[0]!.id, "Awaiting review");
    await db.update(questions).set({ status: "reported" }).where(eq(questions.id, hidden.id));
    const r = await startCourse(course.id, "exam", 20);
    const planned = r.body.session.items.map((i: { questionId: string }) => i.questionId);
    expect(planned).not.toContain(qs[0]!.id);
    expect(planned).not.toContain(hidden.id);
    expect(planned).toHaveLength(2);
  });
});

describe("exam mode", () => {
  it("conceals correctness until the session ends, and spreads questions across sets", async () => {
    const { course } = await makeCourse([5, 5, 5]);
    const { body } = await startCourse(course.id, "exam", 20);
    expect(body.session).toMatchObject({ mode: "exam", revealMode: "end", timeBudgetMinutes: 20 });
    expect(body.plan.reasons[0]).toMatch(/Practice exam: 10 questions from 3 question sets/);
    const id = body.session.id;
    const q = body.session.items[0].questionId;

    const first = await answer(id, q, choose("a"));
    expect(first.body.result).toMatchObject({ disclosure: "none" });
    for (const leak of [
      SECRET_EXPLANATION,
      "correctOptionIds",
      "correctAnswer",
      "outcome",
      "isCorrect",
    ]) {
      expect(first.text).not.toContain(leak);
    }
    const during = await view(id);
    expect(during.text).not.toContain(SECRET_EXPLANATION);
    expect(during.text).not.toMatch(/"outcome"|"isCorrect"|correctAnswer/);
    expect((await results(id)).status).toBe(409);

    const done = await complete(id);
    expect(done.status).toBe(200);
    expect(done.body.session.items[0].result).toMatchObject({
      disclosure: "full",
      outcome: "incorrect",
    });
    expect((await view(id)).text).toContain(SECRET_EXPLANATION);
  });

  it("refuses help, by the guard B5 must call", () => {
    expect(() => assertHelpAllowed({ mode: "exam" })).toThrowError(/Hints are turned off/);
    try {
      assertHelpAllowed({ mode: "exam" });
    } catch (error) {
      expect(error).toMatchObject({ status: 403, code: "help_disabled_in_exam" });
    }
    expect(() => assertHelpAllowed({ mode: "review" })).not.toThrow();
    expect(() => assertHelpAllowed({ mode: "quiz" })).not.toThrow();
  });

  it("does not grant a second try in an exam", async () => {
    const { course } = await makeCourse([4]);
    const { body } = await startCourse(course.id, "exam", 10);
    const q = body.session.items[0].questionId;
    await answer(body.session.id, q, choose("a"));
    const second = await answer(body.session.id, q, choose("b"), key(), 2);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("already_answered");
  });
});

describe("time budget", () => {
  it("finishes the answer in progress, then stops offering questions", async () => {
    const { course } = await makeCourse([12]);
    const { session } = await startOrResumeCourseSession(
      db,
      alice.id,
      { courseId: course.id, mode: "review", timeBudgetMinutes: 10 },
      t0,
    );
    const items = session.items.map((i) => i.questionId);
    expect(items.length).toBe(5);

    const early = await submit(session.id, items[0]!, ["b"], at(100));
    expect(early.sessionEnded).toBe(false);
    const stillOpen = await submit(session.id, items[1]!, ["b"], at(400));
    expect(stillOpen.sessionEnded).toBe(false);

    // The student is looking at question 3 when the 10 minutes are used up; the answer counts.
    const last = await submit(session.id, items[2]!, ["b"], at(601));
    expect(last.sessionEnded).toBe(true);
    expect(last.result).toMatchObject({ disclosure: "full", outcome: "correct" });

    const [row] = await db.select().from(studySessions).where(eq(studySessions.id, session.id));
    expect(row).toMatchObject({ state: "completed", elapsedSeconds: 601 });
    expect(row?.completedAt?.toISOString()).toBe(at(601).toISOString());
    expect((await view(session.id)).body.session.current).toBeNull();
    await expect(submit(session.id, items[3]!, ["b"], at(700))).rejects.toMatchObject({
      code: "session_completed",
    });

    // Nothing was lost, and untouched questions never became attempts.
    expect(await db.select().from(attempts).where(eq(attempts.sessionId, session.id))).toHaveLength(
      3,
    );
  });

  it("counts only active time: a paused session does not run out", async () => {
    const { course } = await makeCourse([12]);
    const { session } = await startOrResumeCourseSession(
      db,
      alice.id,
      { courseId: course.id, mode: "review", timeBudgetMinutes: 10 },
      t0,
    );
    const items = session.items.map((i) => i.questionId);
    await submit(session.id, items[0]!, ["b"], at(200));
    await pauseSession(db, alice.id, session.id, at(250));
    await resumeSession(db, alice.id, session.id, at(10_000));
    const after = await submit(session.id, items[1]!, ["b"], at(10_100));
    expect(after.sessionEnded).toBe(false); // 250s + 100s of active time
    const [row] = await db.select().from(studySessions).where(eq(studySessions.id, session.id));
    expect(row?.state).toBe("active");
    const ended = await submit(session.id, items[2]!, ["b"], at(10_100 + 300));
    expect(ended.sessionEnded).toBe(true); // 250 + 400 = 650s
  });

  it("returns a replayed answer from storage, even after the budget ended the session", async () => {
    const { course } = await makeCourse([12]);
    const { session } = await startOrResumeCourseSession(
      db,
      alice.id,
      { courseId: course.id, mode: "review", timeBudgetMinutes: 5 },
      t0,
    );
    const [a, b] = session.items.map((i) => i.questionId);
    const input = {
      questionId: a!,
      response: { kind: "options" as const, selectedOptionIds: ["b"] },
      idempotencyKey: key(),
      pass: 1 as const,
    };
    const first = await submitAnswer(db, alice.id, session.id, input, at(50));
    await submit(session.id, b!, ["b"], at(400)); // ends the session
    const replay = await submitAnswer(db, alice.id, session.id, input, at(500));
    expect(replay.replayed).toBe(true);
    expect(replay.sessionEnded).toBe(true);
    expect(replay.result.attemptId).toBe(first.result.attemptId);
    expect(await db.select().from(attempts).where(eq(attempts.sessionId, session.id))).toHaveLength(
      2,
    );
  });

  it("leaves unreached due questions due, and keeps answered attempts when ended early", async () => {
    const { course, questions: qs } = await makeCourse([12]);
    await makeDue(qs.slice(0, 5).map((q) => q.id));
    const { session } = await startOrResumeCourseSession(
      db,
      alice.id,
      { courseId: course.id, mode: "review", timeBudgetMinutes: 10 },
      t0,
    );
    const items = session.items.map((i) => i.questionId);
    await submit(session.id, items[0]!, ["b"], at(30));
    const done = await completeSession(db, alice.id, session.id, at(60));
    expect(done.summary).toMatchObject({ answered: 1, correct: 1, unanswered: 4 });
    expect(await completeSession(db, alice.id, session.id, at(90))).toMatchObject({
      summary: { answered: 1 },
    });

    const untouched = items.slice(1).filter((id) => qs.slice(0, 5).some((q) => q.id === id));
    expect(untouched.length).toBeGreaterThan(0);
    const states = await db
      .select()
      .from(reviewStates)
      .where(and(eq(reviewStates.userId, alice.id), inArray(reviewStates.questionId, untouched)));
    for (const s of states) expect(s.nextDueAt!.getTime()).toBeLessThan(Date.now());
    expect(await db.select().from(attempts).where(eq(attempts.sessionId, session.id))).toHaveLength(
      1,
    );
  });
});

describe("results", () => {
  it("are not available while the session is running, and are hidden from other users", async () => {
    const { course } = await makeCourse([4]);
    const { body } = await startCourse(course.id, "review", 5);
    const id = body.session.id;
    expect((await results(id)).body.error.code).toBe("session_in_progress");
    await pauseSession(db, alice.id, id);
    expect((await results(id)).status).toBe(409);
    await complete(id);
    expect((await results(id)).status).toBe(200);
    expect((await results(id, bob)).status).toBe(404);
    expect((await results(id, null)).status).toBe(401);
    expect((await results(randomUUID())).status).toBe(404);
  });

  it("separates attempts from unique questions, and independent from assisted answers", async () => {
    const { course, questions: qs } = await makeCourse([8]);
    const { body } = await startCourse(course.id, "review", 10);
    const id = body.session.id;
    const [q1, q2, q3] = body.session.items.map(
      (i: { questionId: string }) => i.questionId,
    ) as string[];

    // q1: wrong first try, then a retry. q2: right unaided. q3: right after a hint.
    await answer(id, q1!, choose("a"));
    await answer(id, q2!, choose("b"));
    await db.insert(helpEvents).values({
      userId: alice.id,
      sessionId: id,
      questionId: q3!,
      questionRevisionId: body.session.items[2]
        ? (
            await db
              .select({ r: questions.currentRevisionId })
              .from(questions)
              .where(eq(questions.id, q3!))
          )[0]!.r!
        : "",
      pass: 1,
      action: "small_hint",
      level: "conceptual_hint",
      contentText: "Look at option B.",
    });
    await answer(id, q3!, choose("b"));
    await answer(id, q1!, choose("b"), key(), 2);
    await complete(id);

    const r = (await results(id)).body.results;
    expect(r).toMatchObject({
      mode: "review",
      uniqueQuestions: 3,
      attempts: 4,
      firstPass: {
        answered: 3,
        independentCorrect: 1,
        assistedCorrect: 1,
        incorrect: 1,
        uncertain: 0,
      },
      retry: { answered: 1, correct: 1, incorrect: 0 },
    });
    expect(r.firstPass.unanswered).toBe(
      r.firstPass.answered === 3 ? body.session.items.length - 3 : -1,
    );
    expect(r.originalQuestions).toBe(3);
    expect(r.generatedQuestions).toBe(0);
    expect(r.questionSetsNeedingPractice).toEqual([
      { questionSetId: expect.any(String), title: "Set 1", missed: 1, assisted: 1, unchecked: 0 },
    ]);
    expect(qs.length).toBe(8);
  });

  it("gives the same numbers on repeat reads and in the completion summary", async () => {
    const { course } = await makeCourse([6]);
    const { body } = await startCourse(course.id, "review", 5);
    const id = body.session.id;
    await answer(id, body.session.items[0].questionId, choose("b"));
    const done = await complete(id);
    const a = (await results(id)).body.results;
    const b = (await results(id)).body.results;
    expect(b).toEqual(a);
    expect(done.body.summary).toMatchObject({
      answered: a.firstPass.answered,
      correct: a.firstPass.independentCorrect + a.firstPass.assistedCorrect,
      incorrect: a.firstPass.incorrect,
      unanswered: a.firstPass.unanswered,
    });
  });

  it("reads where a question came from on the revision that was answered", async () => {
    const { course, sets } = await makeCourse([2]);
    const generated = await addQuestion(sets[0]!.id, "Generated variant");
    await addRevision(db, generated.id, {
      ...contentToRevision({
        type: "mcq_single",
        prompt: "Generated variant",
        options: [
          { id: "a", text: "A" },
          { id: "b", text: "B" },
        ],
        correctOptionIds: ["b"],
      }),
      origin: "ai_variant",
      evidenceStatus: "human_reviewed",
      createdBy: alice.id,
    });
    const { body } = await startCourse(course.id, "exam", 20);
    const id = body.session.id;
    for (const item of body.session.items) await answer(id, item.questionId, choose("b"));
    // Editing the question afterwards must not change what this session reports.
    await addRevision(db, generated.id, {
      ...contentToRevision({
        type: "mcq_single",
        prompt: "Now rewritten",
        options: [
          { id: "a", text: "A" },
          { id: "b", text: "B" },
        ],
        correctOptionIds: ["b"],
      }),
      origin: "original",
      evidenceStatus: "human_reviewed",
      createdBy: alice.id,
    });
    await complete(id);
    const r = (await results(id)).body.results;
    expect(r).toMatchObject({ uniqueQuestions: 3, originalQuestions: 2, generatedQuestions: 1 });
  });

  it("reports the next planned review from the student's own schedule", async () => {
    const { course } = await makeCourse([4]);
    const empty = await startCourse(course.id, "review", 5);
    await complete(empty.body.session.id);
    expect((await results(empty.body.session.id)).body.results.nextReviewAt).toBeNull();

    const { body } = await startCourse(course.id, "review", 5);
    await answer(body.session.id, body.session.items[0].questionId, choose("b"));
    await complete(body.session.id);
    const r = (await results(body.session.id)).body.results;
    expect(typeof r.nextReviewAt).toBe("string");
    expect(new Date(r.nextReviewAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("counts a question that could not be checked as unchecked, never as a miss", async () => {
    const { course } = await makeCourse([3]);
    const { body } = await startCourse(course.id, "exam", 10);
    await complete(body.session.id);
    const r = (await results(body.session.id)).body.results;
    expect(r.firstPass).toMatchObject({ answered: 0, incorrect: 0, uncertain: 0 });
    expect(r.firstPass.unanswered).toBe(body.session.items.length);
    expect(r.questionSetsNeedingPractice).toEqual([]);
  });
});
