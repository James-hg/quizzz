import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST as answerPost } from "@/app/api/sessions/[sessionId]/answers/route";
import { POST as completePost } from "@/app/api/sessions/[sessionId]/complete/route";
import { POST as helpPost } from "@/app/api/sessions/[sessionId]/help/route";
import { GET as resultsGet } from "@/app/api/sessions/[sessionId]/results/route";
import { GET as sessionGet } from "@/app/api/sessions/[sessionId]/route";
import { POST as sessionsPost } from "@/app/api/sessions/route";
import { POST as consentPost } from "@/app/api/ai/consent/route";
import { GET as todayGet } from "@/app/api/today/route";
import { AI_NOTICE_VERSION } from "@/lib/ai-consent";
import { setAiProviderForTesting } from "@/server/ai";
import type { AiProvider } from "@/server/ai/provider";
import { createCourse } from "@/server/content/courses";
import { createQuestionSet } from "@/server/content/question-sets";
import { createQuestion } from "@/server/content/questions";
import { getDb } from "@/server/db";
import { call } from "@/test/api";
import { resetAiState } from "@/test/ai-state";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";

process.env.AUTH_RATE_LIMIT_MAX = "1000";

const db = getDb();
let alice: TestUser;
let courseId: string;

beforeAll(async () => {
  alice = await signUpUser(db);
  // Help from the model needs the user to have accepted the AI data notice.
  const consent = await call(consentPost, "/api/ai/consent", alice, {
    body: { noticeVersion: AI_NOTICE_VERSION, accepted: true },
  });
  expect(consent.status).toBeLessThan(300);
  courseId = (await createCourse(db, alice.id, { title: "CS", subject: "S" })).id;
  const set = await createQuestionSet(db, alice.id, courseId, `Set ${randomUUID()}`);
  for (let i = 0; i < 3; i++) {
    await createQuestion(
      db,
      alice.id,
      set.id,
      {
        type: "mcq_single",
        prompt: `Which structure is first-in first-out? (${i + 1})`,
        options: [
          { id: "a", text: "A stack" },
          { id: "b", text: "A queue" },
        ],
        correctOptionIds: ["b"],
      },
      true,
    );
  }
});
afterEach(async () => {
  setAiProviderForTesting(undefined);
  await resetAiState(db);
});
afterAll(async () => {
  await deleteUsers(db, [alice.id]);
});

function model() {
  const provider: AiProvider = {
    name: "gemini",
    async generateText() {
      throw new Error("not used");
    },
    streamText() {
      throw new Error("not used");
    },
    async generateStructured(_input, schema) {
      return schema.parse({
        text: "Think about which one serves the oldest item first.",
        level: "conceptual_hint",
        citedSegmentIds: [],
        sourceSupported: false,
      });
    },
  };
  setAiProviderForTesting(provider);
}

const start = (mode: "review" | "exam") =>
  call(sessionsPost, "/api/sessions", alice, {
    body: { courseId, mode, timeBudgetMinutes: 10 },
  });
const view = (sessionId: string) => call(sessionGet, "/api/x", alice, { params: { sessionId } });
const answer = (sessionId: string, questionId: string, selected: string, pass = 1) =>
  call(answerPost, "/api/x", alice, {
    body: {
      questionId,
      response: { kind: "options", selectedOptionIds: [selected] },
      idempotencyKey: `key-${randomUUID()}`,
      pass,
    },
    params: { sessionId },
  });

describe("a budgeted course session with one help request", () => {
  it("opens from the home recommendation and shows the help as assisted in the results", async () => {
    model();
    const today = await call(todayGet, "/api/today?courseId=" + courseId, alice);
    expect(today.status).toBe(200);
    expect(today.body.budgetOptions).toEqual([5, 10, 20]);

    const started = await start("review");
    expect(started.status).toBeLessThan(300);
    const sessionId = started.body.session.id as string;
    expect(started.body.session).toMatchObject({
      questionSetId: null,
      courseId,
      timeBudgetMinutes: 10,
    });

    // One help request, as the page makes it: only the question and the kind of help.
    const first = (await view(sessionId)).body.session.current;
    const help = await call(helpPost, "/api/x", alice, {
      body: { questionId: first.questionId, action: "small_hint" },
      params: { sessionId },
    });
    expect(help.status).toBe(200);
    expect(help.body.help).toMatchObject({ origin: "ai_proposed", action: "small_hint" });
    expect(JSON.stringify(help.body)).not.toContain("correctOptionIds");

    expect((await answer(sessionId, first.questionId, "b")).status).toBe(201);

    // A second question answered on its own.
    const next = (await view(sessionId)).body.session.current;
    expect(next.questionId).not.toBe(first.questionId);
    expect((await answer(sessionId, next.questionId, "b")).status).toBe(201);

    // Results are not available while the session is running.
    const early = await call(resultsGet, "/api/x", alice, { params: { sessionId } });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("session_in_progress");

    const done = await call(completePost, "/api/x", alice, { body: {}, params: { sessionId } });
    expect(done.status).toBe(200);

    const results = await call(resultsGet, "/api/x", alice, { params: { sessionId } });
    expect(results.status).toBe(200);
    expect(results.body.results.firstPass).toMatchObject({
      answered: 2,
      independentCorrect: 1,
      assistedCorrect: 1,
    });
    expect(results.body.results).toMatchObject({
      attempts: 2,
      uniqueQuestions: 2,
      timeBudgetMinutes: 10,
    });
  });

  it("gives no help in exam practice, and hides its results until it ends", async () => {
    model();
    const started = await start("exam");
    const sessionId = started.body.session.id as string;
    const q = (await view(sessionId)).body.session.current;
    const help = await call(helpPost, "/api/x", alice, {
      body: { questionId: q.questionId, action: "small_hint" },
      params: { sessionId },
    });
    expect(help.status).toBe(403);
    expect(help.body.error.code).toBe("help_disabled_in_exam");
    const early = await call(resultsGet, "/api/x", alice, { params: { sessionId } });
    expect(early.status).toBe(409);
    await call(completePost, "/api/x", alice, { body: {}, params: { sessionId } });
  });

  it("serves the same session again after a reload, with nothing about the answers", async () => {
    const started = await start("review");
    const sessionId = started.body.session.id as string;
    const again = await view(sessionId);
    expect(again.body.session.id).toBe(sessionId);
    expect(JSON.stringify(again.body)).not.toContain("correctOptionIds");
    await call(completePost, "/api/x", alice, { body: {}, params: { sessionId } });
  });
});
