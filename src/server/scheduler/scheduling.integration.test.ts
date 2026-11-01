import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as answerPost } from "@/app/api/sessions/[sessionId]/answers/route";
import { POST as completePost } from "@/app/api/sessions/[sessionId]/complete/route";
import { POST as sessionsPost } from "@/app/api/sessions/route";
import { createCourse, updateCourse } from "@/server/content/courses";
import { createQuestionSet } from "@/server/content/question-sets";
import { createQuestion } from "@/server/content/questions";
import { getDb } from "@/server/db";
import { insertAttempt } from "@/server/db/repositories/attempts";
import { attempts, helpEvents, questions, reviewStates, user } from "@/server/db/schema";
import { submitAnswer } from "@/server/sessions/answers";
import { call } from "@/test/api";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { localDate, startOfLocalDay } from "./dates";

process.env.AUTH_RATE_LIMIT_MAX = "1000";

const db = getDb();
const TZ = "America/Vancouver";
let alice: TestUser;

beforeAll(async () => {
  alice = await signUpUser(db);
  await db.update(user).set({ timezone: TZ }).where(eq(user.id, alice.id));
});
afterAll(async () => {
  await deleteUsers(db, [alice.id]);
});

// Noon in Vancouver on Mon 2026-02-02, then each following day at the same hour.
const day = (n: number) => new Date(Date.UTC(2026, 1, 2 + n, 20, 0, 0));
const key = () => `key-${randomUUID()}`;
const right = { kind: "options" as const, selectedOptionIds: ["b"] };
const wrong = { kind: "options" as const, selectedOptionIds: ["a"] };

async function makeQuestion(opts: { examDate?: string } = {}) {
  const course = await createCourse(db, alice.id, { title: "CS", subject: "Intro" });
  if (opts.examDate) await updateCourse(db, alice.id, course.id, { examDate: opts.examDate });
  const set = await createQuestionSet(db, alice.id, course.id, "Reviews");
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

const startSession = async (setId: string, revealMode = "each") => {
  const res = await call(sessionsPost, "/api/sessions", alice, {
    body: { questionSetId: setId, mode: "quiz", revealMode },
  });
  expect(res.status).toBeLessThan(300);
  return res.body.session.id as string;
};
const finish = (sessionId: string) =>
  call(completePost, "/api/x", alice, { body: {}, params: { sessionId } });

/** Answers once on a given day in a fresh session, which is how reviews really happen. */
async function answerOn(
  setId: string,
  questionId: string,
  response: unknown,
  when: Date,
  extra: { before?: (sessionId: string) => Promise<void>; idempotencyKey?: string } = {},
) {
  const sessionId = await startSession(setId);
  await extra.before?.(sessionId);
  const out = await submitAnswer(
    db,
    alice.id,
    sessionId,
    {
      questionId,
      response: response as never,
      idempotencyKey: extra.idempotencyKey ?? key(),
      pass: 1,
    },
    when,
  );
  await finish(sessionId);
  return { sessionId, out };
}

const stateOf = async (questionId: string) =>
  (
    await db
      .select()
      .from(reviewStates)
      .where(and(eq(reviewStates.userId, alice.id), eq(reviewStates.questionId, questionId)))
  )[0];

const askForHelp = (
  sessionId: string,
  s: { questionId: string; revisionId: string },
  level: "conceptual_hint" | "next_step_hint",
  createdAt: Date,
) =>
  db.insert(helpEvents).values({
    userId: alice.id,
    sessionId,
    questionId: s.questionId,
    questionRevisionId: s.revisionId,
    pass: 1,
    action: "small_hint",
    level,
    contentText: "Some help",
    createdAt,
  });

describe("scheduling through the answer endpoint", () => {
  it("schedules the first independent success for the next local day, with a reason", async () => {
    const { set, question } = await makeQuestion();
    const sessionId = await startSession(set.id);
    const res = await call(answerPost, "/api/x", alice, {
      body: { questionId: question.id, response: right, idempotencyKey: key(), pass: 1 },
      params: { sessionId },
    });
    expect(res.status).toBe(201);

    const state = await stateOf(question.id);
    expect(state).toMatchObject({
      state: "reviewing",
      stepIndex: 0,
      distinctSuccessDays: 1,
      policyVersion: "v1",
    });
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(localDate(state!.nextDueAt!, TZ)).toBe(localDate(tomorrow, TZ));
    expect(state!.lastReason).toMatch(/Recalled on your own/);
    const [attempt] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, state!.lastAttemptId!));
    expect(attempt).toMatchObject({ questionId: question.id, assistanceLevel: "none" });
  });

  it("does not apply the schedule twice when a submit is retried", async () => {
    const { set, question } = await makeQuestion();
    const sessionId = await startSession(set.id);
    const body = { questionId: question.id, response: right, idempotencyKey: key(), pass: 1 };
    const first = await call(answerPost, "/api/x", alice, { body, params: { sessionId } });
    const before = await stateOf(question.id);
    const again = await call(answerPost, "/api/x", alice, { body, params: { sessionId } });
    expect(first.status).toBe(201);
    expect(again.body.replayed).toBe(true);
    expect(await stateOf(question.id)).toEqual(before);
    expect(
      await db.select().from(attempts).where(eq(attempts.questionId, question.id)),
    ).toHaveLength(1);
  });
});

describe("what counts as independent recall", () => {
  it("advances after an independent success on a later day", async () => {
    const { set, question } = await makeQuestion();
    await answerOn(set.id, question.id, right, day(0));
    const first = await stateOf(question.id);
    expect(first!.nextDueAt).toEqual(startOfLocalDay("2026-02-03", TZ));

    await answerOn(set.id, question.id, right, day(1));
    const second = await stateOf(question.id);
    expect(second).toMatchObject({ stepIndex: 1, delayedSuccessCount: 1, distinctSuccessDays: 2 });
    expect(second!.nextDueAt).toEqual(startOfLocalDay("2026-02-06", TZ)); // 3 days later
    expect(second!.lastReason).toMatch(/Recalled on 2 separate days/);
  });

  it("does not advance for a correct answer after a hint, and says so", async () => {
    const { set, question } = await makeQuestion();
    await answerOn(set.id, question.id, right, day(0));
    const before = await stateOf(question.id);

    const { sessionId } = await answerOn(set.id, question.id, right, day(1), {
      before: async (id) => {
        await askForHelp(
          id,
          { questionId: question.id, revisionId: question.revisionId },
          "next_step_hint",
          day(1),
        );
      },
    });
    const after = await stateOf(question.id);
    expect(after).toMatchObject({
      state: "learning",
      stepIndex: before!.stepIndex,
      delayedSuccessCount: 0,
      lastIndependentSuccessAt: before!.lastIndependentSuccessAt,
    });
    expect(after!.nextDueAt).toEqual(startOfLocalDay("2026-02-04", TZ));
    expect(after!.lastReason).toMatch(/You needed a hint/);

    // The help is recorded on the attempt, and linked to it.
    const [attempt] = await db.select().from(attempts).where(eq(attempts.sessionId, sessionId));
    expect(attempt!.assistanceLevel).toBe("next_step_hint");
    const [help] = await db.select().from(helpEvents).where(eq(helpEvents.sessionId, sessionId));
    expect(help!.attemptId).toBe(attempt!.id);
  });

  it("does not count success on a day the student already saw the answer as delayed recall", async () => {
    const { set, question } = await makeQuestion();
    await answerOn(set.id, question.id, right, day(0));
    // Earlier on day 1 the question was shown as practice (the verdict and solution were seen),
    // which leaves the schedule alone, so the question is still due when answered below.
    const earlier = await startSession(set.id);
    await insertAttempt(db, {
      sessionId: earlier,
      userId: alice.id,
      questionId: question.id,
      questionRevisionId: question.revisionId,
      response: wrong,
      isCorrect: false,
      gradingOutcome: "incorrect",
      activityRole: "practice",
      pass: 2,
      idempotencyKey: key(),
      startedAt: new Date(day(1).getTime() - 3 * 3_600_000),
      submittedAt: new Date(day(1).getTime() - 3 * 3_600_000),
    });
    await finish(earlier);

    await answerOn(set.id, question.id, right, day(1));
    const after = await stateOf(question.id);
    expect(after).toMatchObject({ stepIndex: 0, delayedSuccessCount: 0 });
    expect(after!.lastReason).toMatch(/earlier today/);
  });

  it("then lets a later unaided answer count again", async () => {
    const { set, question } = await makeQuestion();
    await answerOn(set.id, question.id, right, day(0));
    await answerOn(set.id, question.id, right, day(1), {
      before: async (id) => {
        await askForHelp(
          id,
          { questionId: question.id, revisionId: question.revisionId },
          "conceptual_hint",
          day(1),
        );
      },
    });
    await answerOn(set.id, question.id, right, day(2));
    expect(await stateOf(question.id)).toMatchObject({
      state: "reviewing",
      delayedSuccessCount: 1,
    });
  });

  it("brings a missed question back tomorrow and counts a lapse only after it was recalled", async () => {
    const { set, question } = await makeQuestion();
    await answerOn(set.id, question.id, wrong, day(0));
    expect(await stateOf(question.id)).toMatchObject({ state: "learning", lapses: 0 });

    await answerOn(set.id, question.id, right, day(1));
    await answerOn(set.id, question.id, wrong, day(2));
    const state = await stateOf(question.id);
    expect(state).toMatchObject({ state: "learning", lapses: 1 });
    expect(state!.nextDueAt).toEqual(startOfLocalDay("2026-02-05", TZ));
  });

  it("ignores a retry in the same session: it follows a verdict the student already saw", async () => {
    const { set, question } = await makeQuestion();
    const sessionId = await startSession(set.id, "requeue");
    const when = day(0);
    await submitAnswer(
      db,
      alice.id,
      sessionId,
      { questionId: question.id, response: wrong, idempotencyKey: key(), pass: 1 },
      when,
    );
    const afterMiss = await stateOf(question.id);
    expect(afterMiss).toMatchObject({ state: "learning" });
    await submitAnswer(
      db,
      alice.id,
      sessionId,
      { questionId: question.id, response: right, idempotencyKey: key(), pass: 2 },
      new Date(when.getTime() + 60_000),
    );
    expect(await stateOf(question.id)).toEqual(afterMiss);
  });
});

describe("what is not scheduled", () => {
  it("skips a question that was excluded after the session started", async () => {
    const { set, question } = await makeQuestion();
    const sessionId = await startSession(set.id);
    await db.update(questions).set({ status: "excluded" }).where(eq(questions.id, question.id));
    await submitAnswer(db, alice.id, sessionId, {
      questionId: question.id,
      response: right as never,
      idempotencyKey: key(),
      pass: 1,
    });
    expect(await stateOf(question.id)).toBeUndefined();
  });
});

describe("the exam date", () => {
  it("never schedules past the day before the exam", async () => {
    const { set, question } = await makeQuestion({ examDate: "2026-02-05" });
    await answerOn(set.id, question.id, right, day(0));
    await answerOn(set.id, question.id, right, day(1));
    // The 3 day interval would land on Feb 6; the last review day is Feb 4.
    expect((await stateOf(question.id))!.nextDueAt).toEqual(startOfLocalDay("2026-02-04", TZ));
  });

  it("has no due date once no review day is left", async () => {
    const { set, question } = await makeQuestion({ examDate: "2026-02-03" });
    await answerOn(set.id, question.id, right, day(0));
    const state = await stateOf(question.id);
    expect(state!.nextDueAt).toBeNull();
    expect(state!.lastReason).toMatch(/No review day is left/);
  });
});
