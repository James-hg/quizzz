import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as historyGet } from "@/app/api/question-sets/[setId]/history/route";
import { POST as answerPost } from "@/app/api/sessions/[sessionId]/answers/route";
import { POST as completePost } from "@/app/api/sessions/[sessionId]/complete/route";
import { GET as sessionGet, PATCH as sessionPatch } from "@/app/api/sessions/[sessionId]/route";
import { POST as sessionsPost } from "@/app/api/sessions/route";
import { createCourse } from "@/server/content/courses";
import { createQuestionSet } from "@/server/content/question-sets";
import { createQuestion, setQuestionStatus, updateQuestion } from "@/server/content/questions";
import { getDb } from "@/server/db";
import { addRevision } from "@/server/db/repositories/questions";
import * as schema from "@/server/db/schema";
import { attempts } from "@/server/db/schema";
import { call } from "@/test/api";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { listSetHistory } from "./history";
import {
  completeSession,
  getSession,
  pauseSession,
  resumeSession,
  startOrResumeSession,
} from "./service";

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

const SECRET_ANSWER = "xyzzy-secret-answer";
const SECRET_EXPLANATION = "because-secret-explanation";

async function makeSet(options: { approve?: boolean } = {}) {
  const course = await createCourse(db, alice.id, {
    title: "CS",
    subject: "Intro",
    language: "python",
  });
  const set = await createQuestionSet(db, alice.id, course.id, "Week 1");
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
    options.approve ?? false,
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
    options.approve ?? false,
  );
  return { course, set, q1, q2 };
}

const start = (setId: string, as: TestUser | null = alice) =>
  call(sessionsPost, "/api/sessions", as, { body: { questionSetId: setId, mode: "quiz" } });
const view = (sessionId: string, as: TestUser | null = alice) =>
  call(sessionGet, "/api/x", as, { params: { sessionId } });
const answer = (
  sessionId: string,
  questionId: string,
  response: unknown,
  idempotencyKey: string,
  as: TestUser | null = alice,
) =>
  call(answerPost, "/api/x", as, {
    body: { questionId, response, idempotencyKey },
    params: { sessionId },
  });
const choose = (...ids: string[]) => ({ kind: "options", selectedOptionIds: ids });
const key = () => `key-${randomUUID()}`;

describe("starting and resuming", () => {
  it("creates a session, then resumes the same one", async () => {
    const { set } = await makeSet();
    const first = await start(set.id);
    expect(first.status).toBe(201);
    const second = await start(set.id);
    expect(second.status).toBe(200);
    expect(second.body.session.id).toBe(first.body.session.id);
    expect(first.body.session.progress).toEqual({ total: 2, answered: 0, removed: 0 });
  });

  it("practices owner-written questions without any approval, but skips excluded ones", async () => {
    const { set, q1, q2 } = await makeSet({ approve: false });
    expect(q1.evidenceStatus).toBe("human_reviewed");
    await setQuestionStatus(db, alice.id, q2.id, "excluded");
    const res = await start(set.id);
    expect(res.status).toBe(201);
    expect(res.body.session.items.map((i: { questionId: string }) => i.questionId)).toEqual([
      q1.id,
    ]);
  });

  it("returns 409 when nothing can be practiced", async () => {
    const { set, q1, q2 } = await makeSet();
    await setQuestionStatus(db, alice.id, q1.id, "excluded");
    await setQuestionStatus(db, alice.id, q2.id, "excluded");
    const res = await start(set.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("no_playable_questions");
  });
});

describe("hiding answers", () => {
  it("never exposes keys, explanations, or correctness for unanswered items", async () => {
    const { set } = await makeSet();
    const created = await start(set.id);
    const sessionId = created.body.session.id as string;
    const fetched = await view(sessionId);
    const resumed = await start(set.id);

    for (const response of [created, fetched, resumed]) {
      for (const forbidden of [
        SECRET_ANSWER,
        SECRET_EXPLANATION,
        "answerKey",
        "correctOptionIds",
        "isCorrect",
        "accepted",
        "correctAnswer",
        "explanation",
      ]) {
        expect(response.text, forbidden).not.toContain(forbidden);
      }
    }
    expect(fetched.body.session.current).toMatchObject({ type: "mcq_single", prompt: "Pick b" });
    expect(fetched.body.session.current.options).toEqual([
      { id: "a", text: "A" },
      { id: "b", text: "B" },
      { id: "c", text: "C" },
    ]);
  });

  it("reveals the result only after submission, and keeps other items hidden", async () => {
    const { set, q1 } = await makeSet();
    const sessionId = (await start(set.id)).body.session.id as string;
    const res = await answer(sessionId, q1.id, choose("b"), key());
    expect(res.status).toBe(201);
    expect(res.body.result).toMatchObject({
      outcome: "correct",
      isCorrect: true,
      correctAnswer: { kind: "options", correctOptionIds: ["b"] },
      explanation: SECRET_EXPLANATION,
    });
    expect(res.body.progress).toEqual({ answered: 1, total: 2 });

    const after = await view(sessionId);
    expect(after.body.session.items[0]).toMatchObject({ status: "answered" });
    expect(after.body.session.items[0].result.isCorrect).toBe(true);
    expect(after.body.session.current).toMatchObject({ prompt: "Type the word" });
    expect(after.text).not.toContain(SECRET_ANSWER);
  });
});

describe("grading and idempotency", () => {
  it("grades wrong answers as incorrect", async () => {
    const { set, q1 } = await makeSet();
    const sessionId = (await start(set.id)).body.session.id as string;
    const res = await answer(sessionId, q1.id, choose("a"), key());
    expect(res.body.result).toMatchObject({ outcome: "incorrect", isCorrect: false });
  });

  it("a repeated key returns the same result and creates exactly one attempt", async () => {
    const { set, q1 } = await makeSet();
    const sessionId = (await start(set.id)).body.session.id as string;
    const idempotencyKey = key();
    const first = await answer(sessionId, q1.id, choose("b"), idempotencyKey);
    const retry = await answer(sessionId, q1.id, choose("b"), idempotencyKey);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.result).toEqual(first.body.result);

    const rows = await db.select().from(attempts).where(eq(attempts.sessionId, sessionId));
    expect(rows).toHaveLength(1);
  });

  it("rejects reusing a key for a different question or answering a question twice", async () => {
    const { set, q1, q2 } = await makeSet();
    const sessionId = (await start(set.id)).body.session.id as string;
    const idempotencyKey = key();
    await answer(sessionId, q1.id, choose("b"), idempotencyKey);

    const reuse = await answer(sessionId, q2.id, { kind: "text", text: "x" }, idempotencyKey);
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("idempotency_key_reused");

    const again = await answer(sessionId, q1.id, choose("a"), key());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_answered");
    expect(await db.select().from(attempts).where(eq(attempts.sessionId, sessionId))).toHaveLength(
      1,
    );
  });

  it("returns 409 for answers to a completed session, but still replays a stored result", async () => {
    const { set, q1, q2 } = await makeSet();
    const sessionId = (await start(set.id)).body.session.id as string;
    const idempotencyKey = key();
    await answer(sessionId, q1.id, choose("b"), idempotencyKey);
    const done = await call(completePost, "/api/x", alice, {
      method: "POST",
      params: { sessionId },
    });
    expect(done.status).toBe(200);

    const late = await answer(sessionId, q2.id, { kind: "text", text: SECRET_ANSWER }, key());
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("session_completed");
    expect(await db.select().from(attempts).where(eq(attempts.sessionId, sessionId))).toHaveLength(
      1,
    );

    const replay = await answer(sessionId, q1.id, choose("b"), idempotencyKey);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
  });

  it("rejects malformed responses with 400", async () => {
    const { set, q1, q2 } = await makeSet();
    const sessionId = (await start(set.id)).body.session.id as string;
    const bad = async (id: string, response: unknown) => {
      const res = await answer(sessionId, id, response, key());
      expect(res.status).toBe(400);
      return res.body.error.code as string;
    };
    expect(await bad(q1.id, choose("a", "b"))).toBe("invalid_response");
    expect(await bad(q1.id, choose())).toBe("invalid_response");
    expect(await bad(q1.id, choose("zzz"))).toBe("invalid_response");
    expect(await bad(q1.id, { kind: "text", text: "b" })).toBe("invalid_response");
    expect(await bad(q2.id, choose("a"))).toBe("invalid_response");
    expect((await answer(sessionId, q1.id, choose("b"), "short")).status).toBe(400);
    expect((await answer(sessionId, randomUUID(), choose("b"), key())).status).toBe(404);
  });

  it("grades text answers with normalization", async () => {
    const { set, q2 } = await makeSet();
    const sessionId = (await start(set.id)).body.session.id as string;
    const res = await answer(
      sessionId,
      q2.id,
      { kind: "text", text: `  ${SECRET_ANSWER.toUpperCase()} ` },
      key(),
    );
    expect(res.body.result.outcome).toBe("correct");
  });
});

describe("questions without a resolved answer", () => {
  const noAnswer = {
    type: "mcq_single" as const,
    prompt: "Imported, answer unknown",
    options: [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
    ],
    answerKey: { kind: "unresolved" as const },
    origin: "original" as const,
    evidenceStatus: "unresolved" as const,
  };

  it("are left out of practice instead of being graded", async () => {
    const { set, q1, q2 } = await makeSet();
    await addRevision(db, q1.id, noAnswer);
    const res = await start(set.id);
    expect(res.status).toBe(201);
    expect(res.body.session.items.map((i: { questionId: string }) => i.questionId)).toEqual([
      q2.id,
    ]);
  });

  it("explain themselves when nothing else can be practised", async () => {
    const { set, q1, q2 } = await makeSet();
    await addRevision(db, q1.id, noAnswer);
    await addRevision(db, q2.id, { ...noAnswer, type: "short_answer", options: [] });
    const res = await start(set.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("no_playable_questions");
    expect(res.body.error.details).toMatchObject({ total: 2, playable: 0, noAnswer: 2 });
  });
});

describe("edits during a session", () => {
  it("keeps grading the revision the session started with; the next session uses the new one", async () => {
    const { set, q1 } = await makeSet();
    const sessionId = (await start(set.id)).body.session.id as string;

    await updateQuestion(db, alice.id, q1.id, { correctOptionIds: ["a"], prompt: "Pick a now" });

    const before = await view(sessionId);
    expect(before.body.session.current).toMatchObject({ prompt: "Pick b", revisionNumber: 1 });

    const res = await answer(sessionId, q1.id, choose("b"), key());
    expect(res.body.result.outcome).toBe("correct");
    const [stored] = await db.select().from(attempts).where(eq(attempts.sessionId, sessionId));
    expect(stored!.questionRevisionId).toBe(q1.revisionId);

    await call(completePost, "/api/x", alice, { method: "POST", params: { sessionId } });
    const next = await start(set.id);
    expect(next.status).toBe(201);
    expect(next.body.session.current).toMatchObject({ prompt: "Pick a now", revisionNumber: 2 });
    const second = await answer(next.body.session.id, q1.id, choose("a"), key());
    expect(second.body.result.outcome).toBe("correct");
  });
});

describe("pause, resume, and elapsed time", () => {
  it("accumulates active time across requests and stops counting while paused", async () => {
    const { set } = await makeSet();
    const t = (seconds: number) => new Date(Date.UTC(2026, 0, 5, 12, 0, 0) + seconds * 1000);

    const { session } = await startOrResumeSession(db, alice.id, set.id, t(0));
    const id = session.id;
    expect((await pauseSession(db, alice.id, id, t(30))).elapsedSeconds).toBe(30);
    expect((await getSession(db, alice.id, id, t(90))).elapsedSeconds).toBe(30);

    const resumed = await resumeSession(db, alice.id, id, t(100));
    expect(resumed.state).toBe("active");
    expect((await getSession(db, alice.id, id, t(110))).elapsedSeconds).toBe(40);

    expect((await pauseSession(db, alice.id, id, t(130))).elapsedSeconds).toBe(60);
    // Pausing twice and completing while paused add nothing.
    expect((await pauseSession(db, alice.id, id, t(500))).elapsedSeconds).toBe(60);
    const done = await completeSession(db, alice.id, id, t(900));
    expect(done.summary.elapsedSeconds).toBe(60);
    expect(done.session.state).toBe("completed");
  });

  it("rejects answers while paused and accepts them after resuming", async () => {
    const { set, q1 } = await makeSet();
    const sessionId = (await start(set.id)).body.session.id as string;
    const patch = (action: string) =>
      call(sessionPatch, "/api/x", alice, {
        method: "PATCH",
        body: { action },
        params: { sessionId },
      });

    expect((await patch("pause")).body.session.state).toBe("paused");
    const blocked = await answer(sessionId, q1.id, choose("b"), key());
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("session_paused");

    expect((await patch("resume")).body.session.state).toBe("active");
    expect((await answer(sessionId, q1.id, choose("b"), key())).status).toBe(201);
    expect((await patch("nonsense")).status).toBe(400);
  });

  it("summarizes a session ended early without losing attempts", async () => {
    const { set, q1 } = await makeSet();
    const sessionId = (await start(set.id)).body.session.id as string;
    await answer(sessionId, q1.id, choose("a"), key());
    const done = await call(completePost, "/api/x", alice, {
      method: "POST",
      params: { sessionId },
    });
    expect(done.body.summary).toMatchObject({
      totalItems: 2,
      answered: 1,
      correct: 0,
      incorrect: 1,
      unanswered: 1,
    });
    const again = await call(completePost, "/api/x", alice, {
      method: "POST",
      params: { sessionId },
    });
    expect(again.status).toBe(200);
  });
});

describe("history", () => {
  it("lists completed sessions with counts in a single aggregate query", async () => {
    const { set, q1, q2 } = await makeSet();

    const s1 = (await start(set.id)).body.session.id as string;
    await answer(s1, q1.id, choose("b"), key());
    await answer(s1, q2.id, { kind: "text", text: "wrong" }, key());
    await call(completePost, "/api/x", alice, { method: "POST", params: { sessionId: s1 } });

    const s2 = (await start(set.id)).body.session.id as string;
    await answer(s2, q1.id, choose("a"), key());
    await call(completePost, "/api/x", alice, { method: "POST", params: { sessionId: s2 } });

    // A live session must not appear.
    await start(set.id);

    const res = await call(historyGet, "/api/x", alice, { params: { setId: set.id } });
    expect(res.status).toBe(200);
    const rows = res.body.sessions as {
      sessionId: string;
      totalItems: number;
      answered: number;
      correct: number;
    }[];
    expect(rows.map((r) => r.sessionId)).toEqual([s2, s1]);
    expect(rows[0]).toMatchObject({ totalItems: 2, answered: 1, correct: 0 });
    expect(rows[1]).toMatchObject({ totalItems: 2, answered: 2, correct: 1 });

    const queries: string[] = [];
    const client = postgres(process.env.TEST_DATABASE_URL!, { max: 1, prepare: false });
    const counting = drizzle(client, { schema, logger: { logQuery: (q) => void queries.push(q) } });
    await listSetHistory(counting as never, alice.id, set.id);
    await client.end();
    const aggregates = queries.filter((q) => /group by/i.test(q));
    expect(aggregates).toHaveLength(1);
    // One ownership lookup plus the aggregate, regardless of how many sessions exist.
    expect(queries).toHaveLength(2);
  });
});

describe("ownership", () => {
  it("returns 404 for another user's sessions and sets on every route", async () => {
    const { set, q1 } = await makeSet();
    const sessionId = (await start(set.id)).body.session.id as string;

    const intruder = [
      call(sessionsPost, "/api/sessions", bob, { body: { questionSetId: set.id, mode: "quiz" } }),
      call(sessionGet, "/api/x", bob, { params: { sessionId } }),
      call(sessionPatch, "/api/x", bob, {
        method: "PATCH",
        body: { action: "pause" },
        params: { sessionId },
      }),
      call(answerPost, "/api/x", bob, {
        body: { questionId: q1.id, response: choose("b"), idempotencyKey: key() },
        params: { sessionId },
      }),
      call(completePost, "/api/x", bob, { method: "POST", params: { sessionId } }),
      call(historyGet, "/api/x", bob, { params: { setId: set.id } }),
    ];
    for (const res of await Promise.all(intruder)) expect(res.status).toBe(404);

    const mine = await view(sessionId);
    expect(mine.body.session.state).toBe("active");
    expect(await db.select().from(attempts).where(eq(attempts.sessionId, sessionId))).toHaveLength(
      0,
    );
  });

  it("requires a session cookie", async () => {
    const { set } = await makeSet();
    expect((await start(set.id, null)).status).toBe(401);
  });
});
