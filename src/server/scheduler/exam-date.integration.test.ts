import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PATCH as coursePatch } from "@/app/api/courses/[courseId]/route";
import { GET as resultsGet } from "@/app/api/sessions/[sessionId]/results/route";
import { POST as completePost } from "@/app/api/sessions/[sessionId]/complete/route";
import { POST as sessionsPost } from "@/app/api/sessions/route";
import { GET as todayGet } from "@/app/api/today/route";
import { createCourse } from "@/server/content/courses";
import { createQuestionSet } from "@/server/content/question-sets";
import { createQuestion } from "@/server/content/questions";
import { getDb } from "@/server/db";
import { attempts, reviewStates, user } from "@/server/db/schema";
import { recommendToday } from "@/server/planner/today";
import { submitAnswer } from "@/server/sessions/answers";
import { call } from "@/test/api";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { addDays, localDate, startOfLocalDay } from "./dates";

process.env.AUTH_RATE_LIMIT_MAX = "1000";

const db = getDb();
const TZ = "America/Vancouver";
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  alice = await signUpUser(db);
  bob = await signUpUser(db);
  await db.update(user).set({ timezone: TZ }).where(eq(user.id, alice.id));
});
afterAll(async () => {
  await deleteUsers(db, [alice.id, bob.id]);
});

const key = () => `key-${randomUUID()}`;
const right = { kind: "options" as const, selectedOptionIds: ["b"] };
const wrong = { kind: "options" as const, selectedOptionIds: ["a"] };
const noon = (date: string) => new Date(startOfLocalDay(date, TZ).getTime() + 12 * 3_600_000);
const todayDate = () => localDate(new Date(), TZ);

async function makeCourse(examDate?: string | null) {
  const course = await createCourse(db, alice.id, { title: "Exam course", subject: "S" });
  if (examDate !== undefined) await patchCourse(course.id, { examDate });
  const set = await createQuestionSet(db, alice.id, course.id, "Set");
  const question = await createQuestion(
    db,
    alice.id,
    set.id,
    {
      type: "mcq_single",
      prompt: "Pick b",
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      correctOptionIds: ["b"],
    },
    true,
  );
  return { course, set, question };
}

const patchCourse = (courseId: string, body: unknown, as: TestUser = alice) =>
  call(coursePatch, `/api/courses/${courseId}`, as, {
    method: "PATCH",
    body,
    params: { courseId },
  });
const today = (courseId: string, as: TestUser = alice) =>
  call(todayGet, `/api/today?courseId=${courseId}`, as);

async function answerAt(
  setId: string,
  questionId: string,
  response: unknown,
  when: Date,
): Promise<string> {
  const created = await call(sessionsPost, "/api/sessions", alice, {
    body: { questionSetId: setId, mode: "quiz", revealMode: "each" },
  });
  const sessionId = created.body.session.id as string;
  await submitAnswer(
    db,
    alice.id,
    sessionId,
    { questionId, response: response as never, idempotencyKey: key(), pass: 1 },
    when,
  );
  await call(completePost, "/api/x", alice, { body: {}, params: { sessionId } });
  return sessionId;
}

const stateOf = async (questionId: string) =>
  (
    await db
      .select()
      .from(reviewStates)
      .where(and(eq(reviewStates.userId, alice.id), eq(reviewStates.questionId, questionId)))
  )[0]!;

/** Pretends a check is due, at a given local date, without waiting for real days to pass. */
const setDue = (questionId: string, date: string) =>
  db
    .update(reviewStates)
    .set({ nextDueAt: startOfLocalDay(date, TZ) })
    .where(and(eq(reviewStates.userId, alice.id), eq(reviewStates.questionId, questionId)));

describe("exam tomorrow, then moved or cleared (course API and today)", () => {
  it("explains there is no review day left, and the normal schedule returns when the date moves", async () => {
    const tomorrow = addDays(todayDate(), 1);
    const { course, set, question } = await makeCourse(tomorrow);
    await answerAt(set.id, question.id, right, new Date());

    const state = await stateOf(question.id);
    expect(state.lastReason).toMatch(/No review day is left before your exam/);
    // The interval alone is stored, not null.
    expect(state.nextDueAt).toEqual(startOfLocalDay(tomorrow, TZ));

    const during = (await today(course.id)).body;
    expect(during.dueCount).toBe(0);
    expect(during.reasons.join(" ")).toMatch(/no review day left before your exam/);

    // Move the exam a month out. The same stored date is now due tomorrow.
    const moved = await patchCourse(course.id, { examDate: addDays(todayDate(), 30) });
    expect(moved.status).toBe(200);
    expect((await stateOf(question.id)).nextDueAt).toEqual(state.nextDueAt);
    const tomorrowNoon = noon(tomorrow);
    expect((await recommendToday(db, alice.id, course.id, tomorrowNoon)).dueCount).toBe(1);
  });

  it("restores the normal intervals when the exam date is cleared", async () => {
    const { course, set, question } = await makeCourse(addDays(todayDate(), 3));
    await answerAt(set.id, question.id, right, new Date());
    await setDue(question.id, addDays(todayDate(), 10));
    const lastReviewDay = noon(addDays(todayDate(), 2));
    const dueOn = async (when: Date) =>
      (await recommendToday(db, alice.id, course.id, when)).dueCount;
    expect(await dueOn(lastReviewDay)).toBe(1);

    expect((await patchCourse(course.id, { examDate: null })).status).toBe(200);
    expect(await dueOn(lastReviewDay)).toBe(0);
    expect(await dueOn(noon(addDays(todayDate(), 10)))).toBe(1);
  });

  it("cuts a long interval short only while the exam is upcoming, without rewriting it", async () => {
    const { course, set, question } = await makeCourse(addDays(todayDate(), 4));
    await answerAt(set.id, question.id, right, new Date());
    await setDue(question.id, addDays(todayDate(), 10));
    const stored = (await stateOf(question.id)).nextDueAt;

    const lastReviewDay = noon(addDays(todayDate(), 3));
    expect((await recommendToday(db, alice.id, course.id, lastReviewDay)).dueCount).toBe(1);
    await patchCourse(course.id, { examDate: null });
    expect((await recommendToday(db, alice.id, course.id, lastReviewDay)).dueCount).toBe(0);
    expect((await stateOf(question.id)).nextDueAt).toEqual(stored);
  });
});

describe("exam date passed", () => {
  it("keeps due reviews and says why", async () => {
    const yesterday = addDays(todayDate(), -1);
    const { course, set, question } = await makeCourse();
    await answerAt(set.id, question.id, right, new Date(Date.now() - 3 * 86_400_000));
    await setDue(question.id, addDays(todayDate(), -1));
    await patchCourse(course.id, { examDate: yesterday });

    const { body } = await today(course.id);
    expect(body.dueCount).toBe(1);
    expect(body.reasons.join(" ")).toMatch(/Your exam date has passed\. Reviews are continuing/);
  });

  it("is only visible to the course owner", async () => {
    const { course } = await makeCourse(addDays(todayDate(), -1));
    const asBob = await today(course.id, bob);
    expect(asBob.status).toBe(404);
    expect(JSON.stringify(asBob.body)).not.toMatch(/exam date/i);
    expect((await patchCourse(course.id, { examDate: null }, bob)).status).toBe(404);
  });
});

describe("session results", () => {
  it("shows the effective next review, or says no review day is left", async () => {
    const tomorrow = addDays(todayDate(), 1);
    const { course, set, question } = await makeCourse(tomorrow);
    const sessionId = await answerAt(set.id, question.id, right, new Date());
    const results = async () =>
      (await call(resultsGet, "/api/x", alice, { params: { sessionId } })).body.results;

    const during = await results();
    expect(during.nextReviewAt).toBeNull();
    expect(during.reviewNotice).toMatch(/no review day left before your exam/);

    await patchCourse(course.id, { examDate: null });
    const after = await results();
    expect(after.nextReviewAt).toBe(startOfLocalDay(tomorrow, TZ).toISOString());
    expect(after.reviewNotice).toBeNull();
  });
});

describe("repair migration", () => {
  const sqlText = readFileSync("drizzle/0017_repair_null_review_due_dates.sql", "utf8");
  const run = async () => {
    for (const statement of sqlText.split("--> statement-breakpoint")) {
      await db.execute(sql.raw(statement));
    }
  };
  const nullOut = (questionId: string) =>
    db
      .update(reviewStates)
      .set({ nextDueAt: null })
      .where(and(eq(reviewStates.userId, alice.id), eq(reviewStates.questionId, questionId)));
  const day = (n: number) => noon(addDays("2026-02-02", n));
  const attemptCount = async (questionId: string) =>
    (await db.select().from(attempts).where(eq(attempts.questionId, questionId))).length;

  it("rebuilds missing dates from the interval and the right anchor, and leaves the rest alone", async () => {
    const reviewing = await makeCourse();
    await answerAt(reviewing.set.id, reviewing.question.id, right, day(0));
    await answerAt(reviewing.set.id, reviewing.question.id, right, day(1));

    // Recalled once, then missed: relearning, due the day after the miss, not after the success.
    const learning = await makeCourse();
    await answerAt(learning.set.id, learning.question.id, right, day(0));
    await answerAt(learning.set.id, learning.question.id, wrong, day(1));

    const fresh = await makeCourse();
    await answerAt(fresh.set.id, fresh.question.id, right, day(0));
    const keptDate = (await stateOf(fresh.question.id)).nextDueAt;

    // A reviewing row near a clock change: three local days from Mar 7 is Mar 10.
    const dst = await makeCourse();
    await answerAt(dst.set.id, dst.question.id, right, noon("2026-03-07"));
    await db
      .update(reviewStates)
      .set({ stepIndex: 1, lastIndependentSuccessAt: noon("2026-03-07") })
      .where(eq(reviewStates.questionId, dst.question.id));

    const reasonBefore = (await stateOf(learning.question.id)).lastReason;
    const attemptsBefore = await attemptCount(learning.question.id);
    for (const q of [reviewing.question, learning.question, dst.question]) await nullOut(q.id);

    await run();
    expect((await stateOf(reviewing.question.id)).nextDueAt).toEqual(
      startOfLocalDay("2026-02-06", TZ),
    );
    expect((await stateOf(learning.question.id)).nextDueAt).toEqual(
      startOfLocalDay("2026-02-04", TZ),
    );
    expect((await stateOf(dst.question.id)).nextDueAt).toEqual(startOfLocalDay("2026-03-10", TZ));
    // Untouched: a row that already had a date, the reason text, and the attempts.
    expect((await stateOf(fresh.question.id)).nextDueAt).toEqual(keptDate);
    expect((await stateOf(learning.question.id)).lastReason).toBe(reasonBefore);
    expect(await attemptCount(learning.question.id)).toBe(attemptsBefore);

    // Safe to run again.
    const once = (await stateOf(reviewing.question.id)).nextDueAt;
    await run();
    expect((await stateOf(reviewing.question.id)).nextDueAt).toEqual(once);
  });

  it("does not touch new or suspended rows", async () => {
    const { question } = await makeCourse();
    for (const state of ["new", "suspended"] as const) {
      await db
        .insert(reviewStates)
        .values({ userId: alice.id, questionId: question.id, state, nextDueAt: null })
        .onConflictDoUpdate({
          target: [reviewStates.userId, reviewStates.questionId],
          set: { state, nextDueAt: null },
        });
      await run();
      expect((await stateOf(question.id)).nextDueAt).toBeNull();
    }
  });
});
