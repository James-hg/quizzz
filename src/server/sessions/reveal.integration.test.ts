import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as answerPost } from "@/app/api/sessions/[sessionId]/answers/route";
import { POST as completePost } from "@/app/api/sessions/[sessionId]/complete/route";
import { GET as sessionGet, PATCH as sessionPatch } from "@/app/api/sessions/[sessionId]/route";
import { POST as sessionsPost } from "@/app/api/sessions/route";
import { createCourse } from "@/server/content/courses";
import { createQuestionSet } from "@/server/content/question-sets";
import { createQuestion } from "@/server/content/questions";
import { getDb } from "@/server/db";
import { insertAttempt } from "@/server/db/repositories/attempts";
import { attempts } from "@/server/db/schema";
import { call } from "@/test/api";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { listSetHistory } from "./history";

process.env.AUTH_RATE_LIMIT_MAX = "1000";

const db = getDb();
let alice: TestUser;

beforeAll(async () => {
  alice = await signUpUser(db);
});
afterAll(async () => {
  await deleteUsers(db, [alice.id]);
});

const SECRET_ANSWER = "xyzzy-secret-answer";
const SECRET_EXPLANATION = "because-secret-explanation";
const SECRETS = [SECRET_ANSWER, SECRET_EXPLANATION, "correctOptionIds", "correctAnswer"];
// Accepted (matching ignores case) but spelled differently, so the student's own echoed answer
// cannot be mistaken for the key.
const RIGHT_TEXT = SECRET_ANSWER.toUpperCase();

type Mode = "each" | "end" | "requeue";

async function makeSet() {
  const course = await createCourse(db, alice.id, { title: "CS", subject: "Intro" });
  const set = await createQuestionSet(db, alice.id, course.id, "Reveal");
  const q1 = await createQuestion(
    db,
    alice.id,
    set.id,
    {
      type: "mcq_single",
      prompt: "Pick b",
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
        { id: "c", text: "C" },
      ],
      correctOptionIds: ["b"],
      explanation: SECRET_EXPLANATION,
    },
    true,
  );
  const q2 = await createQuestion(
    db,
    alice.id,
    set.id,
    {
      type: "short_answer",
      prompt: "Type the word",
      accepted: [SECRET_ANSWER],
      caseSensitive: false,
    },
    true,
  );
  return { set, q1, q2 };
}

const start = (setId: string, revealMode?: Mode) =>
  call(sessionsPost, "/api/sessions", alice, {
    body: { questionSetId: setId, mode: "quiz", ...(revealMode ? { revealMode } : {}) },
  });
const view = (sessionId: string) => call(sessionGet, "/api/x", alice, { params: { sessionId } });
const patch = (sessionId: string, action: "pause" | "resume") =>
  call(sessionPatch, "/api/x", alice, { method: "PATCH", body: { action }, params: { sessionId } });
const complete = (sessionId: string) =>
  call(completePost, "/api/x", alice, { body: {}, params: { sessionId } });
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
const choose = (...ids: string[]) => ({ kind: "options", selectedOptionIds: ids });
const text = (value: string) => ({ kind: "text", text: value });
const key = () => `key-${randomUUID()}`;
// A stable name within one test, unique across tests (keys are unique per user).
const issued = new Map<string, string>();
const keyFor = (name: string) => {
  const id = `${name}:${expect.getState().currentTestName}`;
  if (!issued.has(id)) issued.set(id, key());
  return issued.get(id)!;
};
const rowsOf = (sessionId: string) =>
  db
    .select()
    .from(attempts)
    .where(eq(attempts.sessionId, sessionId))
    .orderBy(asc(attempts.submittedAt), asc(attempts.pass));
const leaks = (body: unknown) => SECRETS.filter((s) => JSON.stringify(body).includes(s));

describe("choosing a mode", () => {
  it("stores the mode, defaults to each, and keeps it when the session is resumed", async () => {
    const { set } = await makeSet();
    const first = await start(set.id, "end");
    expect(first.status).toBe(201);
    expect(first.body.session.revealMode).toBe("end");

    await patch(first.body.session.id, "pause");
    await patch(first.body.session.id, "resume");
    expect((await view(first.body.session.id)).body.session.revealMode).toBe("end");

    // Asking for another mode while a session is running resumes that session unchanged.
    const again = await start(set.id, "each");
    expect(again.status).toBe(200);
    expect(again.body.session.id).toBe(first.body.session.id);
    expect(again.body.session.revealMode).toBe("end");

    const { set: other } = await makeSet();
    expect((await start(other.id)).body.session.revealMode).toBe("each");
  });

  it("rejects an unknown mode", async () => {
    const { set } = await makeSet();
    const bad = await call(sessionsPost, "/api/sessions", alice, {
      body: { questionSetId: set.id, mode: "quiz", revealMode: "peek" },
    });
    expect(bad.status).toBe(400);
  });
});

describe("each mode", () => {
  it("shows the full result after every answer and does not retry anything", async () => {
    const { set, q1 } = await makeSet();
    const { body } = await start(set.id, "each");
    const id = body.session.id;
    const wrong = await answer(id, q1.id, choose("a"));
    expect(wrong.body.result).toMatchObject({
      disclosure: "full",
      pass: 1,
      outcome: "incorrect",
      isCorrect: false,
      explanation: SECRET_EXPLANATION,
    });
    expect(wrong.body.requeued).toBe(false);
    expect(wrong.body.progress).toEqual({ answered: 1, total: 2 });
    const again = await answer(id, q1.id, choose("b"));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_answered");
  });
});

describe("end mode", () => {
  it("exposes no answer key, explanation, or correctness until the session is completed", async () => {
    const { set, q1, q2 } = await makeSet();
    const { body } = await start(set.id, "end");
    const id = body.session.id;
    expect(leaks(body)).toEqual([]);

    const first = await answer(id, q1.id, choose("a"), keyFor("key_end_first_1"));
    expect(first.status).toBe(201);
    expect(first.body.result).toMatchObject({ disclosure: "none", pass: 1 });
    for (const field of ["outcome", "isCorrect", "correctAnswer", "explanation"]) {
      expect(first.body.result).not.toHaveProperty(field);
    }
    expect(leaks(first.body)).toEqual([]);
    expect(JSON.stringify(first.body)).not.toMatch(/incorrect|"correct"/);

    // The same key replays the same hidden result.
    const replay = await answer(id, q1.id, choose("a"), keyFor("key_end_first_1"));
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.result).toEqual(first.body.result);
    expect(leaks(replay.body)).toEqual([]);

    await answer(id, q2.id, text(RIGHT_TEXT));
    const during = await view(id);
    expect(
      during.body.session.items.every(
        (i: { result?: { disclosure: string } }) => i.result?.disclosure === "none",
      ),
    ).toBe(true);
    expect(leaks(during.body)).toEqual([]);
    expect(JSON.stringify(during.body)).not.toMatch(/"outcome"|"isCorrect"/);

    const done = await complete(id);
    expect(done.status).toBe(200);
    expect(done.body.summary).toMatchObject({
      totalItems: 2,
      answered: 2,
      correct: 1,
      incorrect: 1,
    });
    const [r1, r2] = done.body.session.items;
    expect(r1.result).toMatchObject({
      disclosure: "full",
      outcome: "incorrect",
      explanation: SECRET_EXPLANATION,
      correctAnswer: { kind: "options", correctOptionIds: ["b"] },
    });
    expect(r2.result).toMatchObject({ disclosure: "full", outcome: "correct" });

    // Everything is available afterwards, including by replaying an old submission.
    expect((await view(id)).body.session.items[0].result.disclosure).toBe("full");
    const late = await answer(id, q1.id, choose("a"), keyFor("key_end_first_1"));
    expect(late.body.result).toMatchObject({ disclosure: "full", outcome: "incorrect" });
  });

  it("does not leak through the first-answer replay of an unrelated key", async () => {
    const { set, q1 } = await makeSet();
    const id = (await start(set.id, "end")).body.session.id;
    const other = await answer(id, q1.id, choose("b"), keyFor("key_reused_1"));
    const reuse = await answer(
      id,
      (await view(id)).body.session.items[1].questionId,
      choose("a"),
      keyFor("key_reused_1"),
    );
    expect(other.status).toBe(201);
    expect(reuse.status).toBe(409);
    expect(leaks(reuse.body)).toEqual([]);
  });
});

describe("requeue mode", () => {
  it("shows the verdict but not the answer for a wrong first try, and asks it once more at the end", async () => {
    const { set, q1, q2 } = await makeSet();
    const id = (await start(set.id, "requeue")).body.session.id;

    const wrong = await answer(id, q1.id, choose("a"), keyFor("key_first_try"));
    expect(wrong.body.result).toMatchObject({
      disclosure: "verdict",
      pass: 1,
      outcome: "incorrect",
      isCorrect: false,
    });
    expect(wrong.body.result).not.toHaveProperty("correctAnswer");
    expect(wrong.body.result).not.toHaveProperty("explanation");
    expect(leaks(wrong.body)).toEqual([]);
    expect(wrong.body.requeued).toBe(true);
    expect(wrong.body.progress).toEqual({ answered: 1, total: 3 });

    const midway = (await view(id)).body.session;
    expect(midway.progress).toMatchObject({ total: 3, answered: 1, retries: 1 });
    expect(
      midway.items.map((i: { questionId: string; pass: number; status: string }) => [
        i.questionId,
        i.pass,
        i.status,
      ]),
    ).toEqual([
      [q1.id, 1, "answered"],
      [q2.id, 1, "pending"],
      [q1.id, 2, "pending"],
    ]);
    expect(midway.current).toMatchObject({ questionId: q2.id, pass: 1 });
    expect(leaks(midway)).toEqual([]);

    // A correct first try is shown in full and is not retried.
    const right = await answer(id, q2.id, text(RIGHT_TEXT));
    expect(right.body.result).toMatchObject({ disclosure: "full", outcome: "correct" });
    expect(right.body.requeued).toBe(false);

    const retrying = (await view(id)).body.session;
    expect(retrying.current).toMatchObject({ questionId: q1.id, pass: 2 });
    expect(leaks({ current: retrying.current })).toEqual([]);

    // The retry is a new attempt with its own key, shown in full, and never queued again.
    const retry = await answer(id, q1.id, choose("c"), keyFor("key_retry_try"), 2);
    expect(retry.status).toBe(201);
    expect(retry.body.result).toMatchObject({
      disclosure: "full",
      pass: 2,
      outcome: "incorrect",
      correctAnswer: { kind: "options", correctOptionIds: ["b"] },
      explanation: SECRET_EXPLANATION,
    });
    expect(retry.body.requeued).toBe(false);
    expect(retry.body.progress).toEqual({ answered: 3, total: 3 });

    // Now that the retry is answered, the first attempt's answer is revealed too.
    expect((await view(id)).body.session.items[0].result.disclosure).toBe("full");

    // First attempt untouched; the retry is separate practice.
    const rows = await rowsOf(id);
    expect(rows).toHaveLength(3);
    const first = rows.find((r) => r.questionId === q1.id && r.pass === 1)!;
    const second = rows.find((r) => r.questionId === q1.id && r.pass === 2)!;
    expect(first).toMatchObject({
      idempotencyKey: keyFor("key_first_try"),
      gradingOutcome: "incorrect",
      activityRole: "scored",
      response: choose("a"),
    });
    expect(second).toMatchObject({
      idempotencyKey: keyFor("key_retry_try"),
      gradingOutcome: "incorrect",
      activityRole: "practice",
      response: choose("c"),
    });

    // No third turn.
    const third = await answer(id, q1.id, choose("b"), key(), 2);
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe("already_answered");
    expect(await rowsOf(id)).toHaveLength(3);
  });

  it("refuses a stale first-try submission instead of using up the retry", async () => {
    const { set, q1, q2 } = await makeSet();
    const id = (await start(set.id, "requeue")).body.session.id;
    // Two tabs show the same unanswered question; the first submits a wrong answer.
    await answer(id, q1.id, choose("a"));
    // The stale tab submits its own first try, with its own key.
    const stale = await answer(id, q1.id, choose("b"));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("already_answered");
    expect(leaks(stale.body)).toEqual([]);

    // The retry is untouched: still pending, and it can be answered once, as pass 2.
    const session = (await view(id)).body.session;
    expect(session.items[2]).toMatchObject({ questionId: q1.id, pass: 2, status: "pending" });
    expect(await rowsOf(id)).toHaveLength(1);
    await answer(id, q2.id, text(RIGHT_TEXT));
    expect((await view(id)).body.session.current).toMatchObject({ questionId: q1.id, pass: 2 });
    const retry = await answer(id, q1.id, choose("b"), key(), 2);
    expect(retry.status).toBe(201);
    expect(retry.body.result).toMatchObject({ pass: 2, outcome: "correct" });
  });

  it("does not accept a retry that was not asked for, or one sent without saying it is a retry", async () => {
    const { set, q1 } = await makeSet();
    const id = (await start(set.id, "requeue")).body.session.id;
    // Not answered yet: pass 2 is not available.
    expect((await answer(id, q1.id, choose("b"), key(), 2)).status).toBe(409);
    await answer(id, q1.id, choose("a"));
    // A request that omits the pass means a first try, which was already used.
    expect((await answer(id, q1.id, choose("b"))).status).toBe(409);
    expect(await rowsOf(id)).toHaveLength(1);
  });

  it("each mode: a second turn is never available, even when asked for", async () => {
    const { set, q1 } = await makeSet();
    const id = (await start(set.id, "each")).body.session.id;
    await answer(id, q1.id, choose("a"));
    expect((await answer(id, q1.id, choose("b"), key(), 2)).status).toBe(409);
  });

  it("reports first tries and retries separately, and counts only first tries in history", async () => {
    const { set, q1, q2 } = await makeSet();
    const id = (await start(set.id, "requeue")).body.session.id;
    await answer(id, q1.id, choose("a"));
    await answer(id, q2.id, text(RIGHT_TEXT));
    await answer(id, q1.id, choose("b"), key(), 2); // the retry is right

    const done = await complete(id);
    expect(done.body.summary).toEqual({
      totalItems: 2,
      answered: 2,
      correct: 1,
      incorrect: 1,
      uncertain: 0,
      unanswered: 0,
      retry: { total: 1, answered: 1, correct: 1, incorrect: 0, uncertain: 0 },
      revealMode: "requeue",
      elapsedSeconds: expect.any(Number),
    });
    const [entry] = await listSetHistory(db, alice.id, set.id);
    expect(entry).toMatchObject({ totalItems: 2, answered: 2, correct: 1 });
  });

  it("reveals everything when the session ends before the retry is answered", async () => {
    const { set, q1, q2 } = await makeSet();
    const id = (await start(set.id, "requeue")).body.session.id;
    await answer(id, q1.id, choose("a"));
    await answer(id, q2.id, text(RIGHT_TEXT));
    const done = await complete(id);
    expect(done.body.summary.retry).toMatchObject({ total: 1, answered: 0 });
    expect(done.body.session.items[0].result).toMatchObject({
      disclosure: "full",
      correctAnswer: { kind: "options", correctOptionIds: ["b"] },
    });
    expect(done.body.session.items[2].status).toBe("pending");
  });

  it("adds nothing to the queue when every first try is right", async () => {
    const { set, q1, q2 } = await makeSet();
    const id = (await start(set.id, "requeue")).body.session.id;
    await answer(id, q1.id, choose("b"));
    await answer(id, q2.id, text(RIGHT_TEXT));
    const session = (await view(id)).body.session;
    expect(session.progress).toMatchObject({ total: 2, answered: 2, retries: 0 });
    expect(session.current).toBeNull();
  });
});

describe("idempotent submission in every mode", () => {
  it.each(["each", "end", "requeue"] as const)(
    "%s: a retry of one request stores one attempt",
    async (mode) => {
      const { set, q1 } = await makeSet();
      const id = (await start(set.id, mode)).body.session.id;
      const [a, b] = [
        await answer(id, q1.id, choose("a"), keyFor("key_same_twice")),
        await answer(id, q1.id, choose("a"), keyFor("key_same_twice")),
      ];
      expect(a.body.replayed).toBe(false);
      expect(b.body.replayed).toBe(true);
      expect(b.body.result).toEqual(a.body.result);
      expect(await rowsOf(id)).toHaveLength(1);
    },
  );

  it.each(["each", "end", "requeue"] as const)(
    "%s: simultaneous submissions with one key store one attempt",
    async (mode) => {
      const { set, q1 } = await makeSet();
      const id = (await start(set.id, mode)).body.session.id;
      const results = await Promise.all(
        Array.from({ length: 5 }, () => answer(id, q1.id, choose("a"), keyFor("key_race_key_1"))),
      );
      expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(await rowsOf(id)).toHaveLength(1);
      if (mode === "requeue") {
        expect((await view(id)).body.session.progress.retries).toBe(1);
      }
    },
  );

  it("requeue: a retried retry request stores one retry attempt", async () => {
    const { set, q1 } = await makeSet();
    const id = (await start(set.id, "requeue")).body.session.id;
    await answer(id, q1.id, choose("a"));
    const [x, y] = [
      await answer(id, q1.id, choose("c"), keyFor("key_retry_key_1"), 2),
      await answer(id, q1.id, choose("c"), keyFor("key_retry_key_1"), 2),
    ];
    expect(x.body.replayed).toBe(false);
    expect(y.body.replayed).toBe(true);
    expect(await rowsOf(id)).toHaveLength(2);
  });

  it("a key used for one question cannot answer another", async () => {
    const { set, q1, q2 } = await makeSet();
    const id = (await start(set.id, "end")).body.session.id;
    await answer(id, q1.id, choose("a"), keyFor("key_one_used"));
    const clash = await answer(id, q2.id, text("x"), keyFor("key_one_used"));
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("idempotency_key_reused");
  });
});

describe("database guarantees", () => {
  it("refuses a second attempt for the same question and pass", async () => {
    const { set, q1 } = await makeSet();
    const id = (await start(set.id, "each")).body.session.id;
    await answer(id, q1.id, choose("a"));
    const [existing] = await rowsOf(id);
    await expect(
      insertAttempt(db, {
        ...existing!,
        id: randomUUID(),
        idempotencyKey: key(),
        response: { kind: "options", selectedOptionIds: ["b"] },
      }),
    ).rejects.toThrow();
    expect(await rowsOf(id)).toHaveLength(1);
  });

  it("defaults pass to 1 for rows written without it", async () => {
    const { set, q1 } = await makeSet();
    const id = (await start(set.id, "each")).body.session.id;
    await answer(id, q1.id, choose("a"));
    const rows = await db.execute<{ pass: number }>(
      sql`select pass from attempts where session_id = ${id}`,
    );
    expect(rows[0]?.pass).toBe(1);
  });
});
