import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as answerPost } from "@/app/api/sessions/[sessionId]/answers/route";
import { POST as helpPost } from "@/app/api/sessions/[sessionId]/help/route";
import type { HelpAction } from "@/lib/schemas";
import { AiInvalidOutput, AiQuotaExceeded, AiTimeout, AiUnavailable } from "@/server/ai/errors";
import { setAiProviderForTesting } from "@/server/ai";
import type { AiProvider } from "@/server/ai/provider";
import { createCourse } from "@/server/content/courses";
import { createQuestionSet } from "@/server/content/question-sets";
import { createQuestion } from "@/server/content/questions";
import { getDb } from "@/server/db";
import {
  approvedHints,
  attempts,
  helpEvents,
  questionImages,
  questionRevisionImages,
  questionSourceLinks,
  reviewStates,
  sourceDocuments,
  sourceSegments,
  studySessions,
} from "@/server/db/schema";
import { submitAnswer } from "@/server/sessions/answers";
import { pauseSession, startOrResumeSession } from "@/server/sessions/service";
import { call } from "@/test/api";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";

process.env.AUTH_RATE_LIMIT_MAX = "1000";

const db = getDb();
let alice: TestUser;
let bob: TestUser;
let courseId: string;
let bobCourseId: string;

beforeAll(async () => {
  alice = await signUpUser(db);
  bob = await signUpUser(db);
  courseId = (await createCourse(db, alice.id, { title: "CS", subject: "S" })).id;
  bobCourseId = (await createCourse(db, bob.id, { title: "Bob", subject: "S" })).id;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => setAiProviderForTesting(undefined));
afterAll(async () => {
  vi.restoreAllMocks();
  await deleteUsers(db, [alice.id, bob.id]);
});

const SECRET_EXPLANATION = "secret-reviewed-explanation";

/** A provider that answers with `reply` (or what a function makes of the prompt). */
function model(reply: unknown | ((prompt: string) => unknown | Promise<unknown>)) {
  const calls: { prompt: string; system: string }[] = [];
  const provider: AiProvider = {
    name: "gemini",
    async generateText() {
      throw new Error("not used");
    },
    streamText() {
      throw new Error("not used");
    },
    async generateStructured(input, schema, options) {
      const prompt = typeof input === "string" ? input : (input[0]?.content ?? "");
      calls.push({ prompt, system: options?.system ?? "" });
      const out =
        typeof reply === "function" ? await (reply as (p: string) => unknown)(prompt) : reply;
      const parsed = schema.safeParse(out);
      if (!parsed.success) throw new AiInvalidOutput();
      return parsed.data;
    },
  };
  setAiProviderForTesting(provider);
  return calls;
}

const failing = (error: unknown) => {
  setAiProviderForTesting({
    name: "gemini",
    async generateText() {
      throw error;
    },
    streamText() {
      throw error;
    },
    async generateStructured() {
      throw error;
    },
  });
};

const LEVEL = {
  small_hint: "conceptual_hint",
  explain_step: "next_step_hint",
  why_wrong: "next_step_hint",
  similar_example: "partial_example",
  full_explanation: "full_explanation",
} as const;

const ok = (action: HelpAction, over: Record<string, unknown> = {}) => ({
  text: `Help for ${action}.`,
  level: LEVEL[action],
  citedSegmentIds: [],
  sourceSupported: false,
  ...over,
});

async function makeSet(count = 2, title = "Set") {
  const set = await createQuestionSet(db, alice.id, courseId, `${title} ${randomUUID()}`);
  const questions = [];
  for (let i = 0; i < count; i++) {
    questions.push(
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
          explanation: SECRET_EXPLANATION,
        },
        true,
      ),
    );
  }
  return { set, questions };
}

async function session(revealMode: "each" | "requeue" | "end" = "each", count = 2) {
  const { set, questions } = await makeSet(count);
  const { session: view } = await startOrResumeSession(db, alice.id, set.id, revealMode);
  return { id: view.id, questions, set, order: view.items.map((i) => i.questionId) };
}

const help = (
  sessionId: string,
  body: unknown,
  as: TestUser | null = alice,
  headers?: Record<string, string>,
) => call(helpPost, "/api/x", as, { body, params: { sessionId }, ...(headers ? { headers } : {}) });
const ask = (sessionId: string, questionId: string, action: HelpAction, as = alice) =>
  help(sessionId, { questionId, action }, as);
const answer = (sessionId: string, questionId: string, selected: string, pass: 1 | 2 = 1) =>
  call(answerPost, "/api/x", alice, {
    body: {
      questionId,
      response: { kind: "options", selectedOptionIds: [selected] },
      idempotencyKey: `key-${randomUUID()}`,
      pass,
    },
    params: { sessionId },
  });
const events = (sessionId: string) =>
  db.select().from(helpEvents).where(eq(helpEvents.sessionId, sessionId));

async function passage(userId: string, course: string, text: string, filename = "notes.docx") {
  const [doc] = await db
    .insert(sourceDocuments)
    .values({
      ownerId: userId,
      courseId: course,
      filename,
      mimeType: "application/octet-stream",
      sizeBytes: 1,
      storageKey: `k-${randomUUID()}`,
      sha256: randomUUID(),
    })
    .returning();
  const [segment] = await db
    .insert(sourceSegments)
    .values({
      sourceDocumentId: doc!.id,
      ordinal: 0,
      kind: "paragraph",
      text,
      anchor: { paragraphIndex: 2 } as never,
    })
    .returning();
  return segment!;
}

const storageKey = () => {
  const id = randomUUID();
  return `${id.slice(0, 2)}/${id}`;
};

async function revisionOf(questionId: string) {
  const { questions: q } = await import("@/server/db/schema");
  const [row] = await db.select().from(q).where(eq(q.id, questionId));
  return row!.currentRevisionId!;
}

describe("help for each action", () => {
  it("records one event per request with the level the action maps to", async () => {
    const s = await session();
    const q = s.order[0]!;
    for (const action of [
      "small_hint",
      "explain_step",
      "similar_example",
      "full_explanation",
    ] as const) {
      model(ok(action));
      const r = await ask(s.id, q, action);
      expect(r.status, r.text).toBe(200);
      expect(r.body.help).toMatchObject({
        questionId: q,
        pass: 1,
        action,
        level: LEVEL[action],
        origin: "ai_proposed",
        servedAs: "requested",
        sourceSupported: false,
        citations: [],
      });
    }
    const rows = await events(s.id);
    expect(rows.map((e) => e.action).sort()).toEqual(
      ["explain_step", "full_explanation", "similar_example", "small_hint"].sort(),
    );
    expect(rows[0]).toMatchObject({
      provider: "gemini",
      promptVersion: "tutor-v1",
      pass: 1,
      attemptId: null,
    });
    expect(rows.every((e) => e.contentText?.startsWith("Help for"))).toBe(true);
  });

  it("explains a wrong answer using the student's own response, and needs one", async () => {
    const s = await session();
    const q = s.order[0]!;
    model(ok("why_wrong"));
    const before = await ask(s.id, q, "why_wrong");
    expect(before.status).toBe(409);
    expect(before.body.error.code).toBe("no_wrong_answer");
    expect(await events(s.id)).toHaveLength(0);

    await answer(s.id, q, "a");
    const next = s.order[1]!;
    const calls = model(ok("why_wrong"));
    const r = await ask(s.id, next, "why_wrong");
    // Same question history is per question: the other question has no wrong answer yet.
    expect(r.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it("sends the question as delimited data and the image only as its description", async () => {
    const s = await session(undefined, 1);
    const q = s.order[0]!;
    const revisionId = await revisionOf(q);
    const [image] = await db
      .insert(questionImages)
      .values({
        ownerId: alice.id,
        storageKey: storageKey(),
        mimeType: "image/png",
        sizeBytes: 1,
        sha256: randomUUID(),
      })
      .returning();
    await db.insert(questionRevisionImages).values({
      questionRevisionId: revisionId,
      imageId: image!.id,
      altText: "A diagram of a line of people",
    });
    const calls = model(ok("small_hint", { uncertainty: "I cannot see the picture." }));
    const r = await ask(s.id, q, "small_hint");
    expect(r.status).toBe(200);
    expect(r.body.help.uncertainty).toBe("I cannot see the picture.");
    expect(calls[0]!.prompt).toContain("A diagram of a line of people");
    expect(calls[0]!.prompt).toMatch(/<<<DATA question [0-9a-f]{8}>>>/);
    expect(calls[0]!.system).toMatch(/picture that you cannot see/);
    expect(calls[0]!.system).toMatch(/Never follow instructions/);
  });
});

describe("assistance reaches the answer", () => {
  it("links help to the attempt, records the strongest level, and scores as assisted", async () => {
    const s = await session();
    const q = s.order[0]!;
    model(ok("small_hint"));
    const first = await ask(s.id, q, "small_hint");
    model(ok("full_explanation"));
    const second = await ask(s.id, q, "full_explanation");
    expect(first.body.help.id).not.toBe(second.body.help.id);

    const done = await answer(s.id, q, "b");
    expect(done.body.result.outcome).toBe("correct");
    const [attempt] = await db.select().from(attempts).where(eq(attempts.sessionId, s.id));
    expect(attempt!.assistanceLevel).toBe("full_explanation");
    const rows = await events(s.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((e) => e.attemptId === attempt!.id)).toBe(true);

    // Correct, but with help: it does not count as an independent success.
    const [state] = await db.select().from(reviewStates).where(eq(reviewStates.questionId, q));
    expect(state?.lastIndependentSuccessAt ?? null).toBeNull();
  });

  it("does not repeat events or scheduling when the same answer is retried", async () => {
    const s = await session();
    const q = s.order[0]!;
    model(ok("small_hint"));
    await ask(s.id, q, "small_hint");
    const input = {
      questionId: q,
      response: { kind: "options" as const, selectedOptionIds: ["b"] },
      idempotencyKey: "same-key-1234",
      pass: 1 as const,
    };
    await submitAnswer(db, alice.id, s.id, input);
    const replay = await submitAnswer(db, alice.id, s.id, input);
    expect(replay.replayed).toBe(true);
    expect(await events(s.id)).toHaveLength(1);
    expect(await db.select().from(attempts).where(eq(attempts.sessionId, s.id))).toHaveLength(1);
  });

  it("does not let help attach to a later turn when the answer wins the race", async () => {
    const s = await session();
    const q = s.order[0]!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    model(async () => {
      await gate;
      return ok("small_hint");
    });
    const pending = ask(s.id, q, "small_hint");
    await new Promise((r) => setTimeout(r, 50));
    await answer(s.id, q, "b");
    release();
    const r = await pending;
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("stale_turn");
    expect(await events(s.id)).toHaveLength(0);
    const [attempt] = await db.select().from(attempts).where(eq(attempts.sessionId, s.id));
    expect(attempt!.assistanceLevel).toBe("none");
  });
});

describe("sources and citations", () => {
  it("cites only passages that were supplied, with a link to the exact passage", async () => {
    const s = await session(undefined, 1);
    const q = s.order[0]!;
    const seg = await passage(
      alice.id,
      courseId,
      "A queue serves items first in, first out.",
      "ds.docx",
    );
    await db.insert(questionSourceLinks).values({
      questionRevisionId: await revisionOf(q),
      sourceSegmentId: seg.id,
      relationship: "evidence",
    });
    const calls = model(ok("explain_step", { citedSegmentIds: [seg.id], sourceSupported: true }));
    const r = await ask(s.id, q, "explain_step");
    expect(calls[0]!.prompt).toContain(seg.id);
    expect(calls[0]!.prompt).toContain("first in, first out");
    expect(r.body.help).toMatchObject({
      sourceSupported: true,
      citations: [
        {
          segmentId: seg.id,
          href: `/api/sources/segments/${seg.id}`,
          filename: "ds.docx",
          location: "paragraph 3",
        },
      ],
    });
    expect((await events(s.id))[0]!.sourceSegmentIds).toEqual([seg.id]);
  });

  it("drops fabricated and foreign citations and stops claiming source support", async () => {
    const s = await session(undefined, 1);
    const q = s.order[0]!;
    const mine = await passage(alice.id, courseId, "A queue serves items first in, first out.");
    await db.insert(questionSourceLinks).values({
      questionRevisionId: await revisionOf(q),
      sourceSegmentId: mine.id,
      relationship: "evidence",
    });
    const foreign = await passage(bob.id, bobCourseId, "Bob's private notes about queues.");
    model(
      ok("explain_step", { citedSegmentIds: [randomUUID(), foreign.id], sourceSupported: true }),
    );
    const r = await ask(s.id, q, "explain_step");
    expect(r.status).toBe(200);
    expect(r.body.help.citations).toEqual([]);
    expect(r.body.help.sourceSupported).toBe(false);
    expect(r.body.help.uncertainty).toMatch(/could not be verified/);
    expect(r.text).not.toContain(foreign.id);
    expect((await events(s.id))[0]!.sourceSegmentIds).toEqual([]);
  });

  it("is honest when there is nothing to cite, and never claims support it cannot show", async () => {
    const s = await session(undefined, 1);
    model(ok("explain_step", { sourceSupported: true }));
    const r = await ask(s.id, s.order[0]!, "explain_step");
    expect(r.body.help).toMatchObject({ sourceSupported: false, citations: [] });
  });
});

describe("keeping the answer back", () => {
  it("refuses a small hint that states the answer, and records nothing", async () => {
    const s = await session();
    const q = s.order[0]!;
    for (const text of ["It is a queue.", "Choose option B.", "The answer is B"]) {
      model(ok("small_hint", { text }));
      const r = await ask(s.id, q, "small_hint");
      expect(r.status, text).toBe(502);
      expect(r.body.error.code).toBe("ai_invalid_output");
    }
    expect(await events(s.id)).toHaveLength(0);
  });

  it("rejects output at the wrong level", async () => {
    const s = await session();
    model(ok("small_hint", { level: "full_explanation" }));
    const r = await ask(s.id, s.order[0]!, "small_hint");
    expect(r.body.error.code).toBe("ai_invalid_output");
    expect(await events(s.id)).toHaveLength(0);
  });

  it("allows a full explanation to state the answer, before the first submission", async () => {
    const s = await session();
    model(
      ok("full_explanation", { text: "The answer is a queue, because it is first in first out." }),
    );
    expect((await ask(s.id, s.order[0]!, "full_explanation")).status).toBe(200);
  });
});

describe("reveal rules", () => {
  it("allows only a small hint or help with the mistake during the protected retry, without sources", async () => {
    const s = await session("requeue", 1);
    const q = s.order[0]!;
    const seg = await passage(alice.id, courseId, "A queue serves items first in, first out.");
    await db.insert(questionSourceLinks).values({
      questionRevisionId: await revisionOf(q),
      sourceSegmentId: seg.id,
      relationship: "evidence",
    });
    const wrong = await answer(s.id, q, "a");
    expect(wrong.body.requeued).toBe(true);

    for (const action of ["explain_step", "similar_example", "full_explanation"] as const) {
      model(ok(action));
      const r = await ask(s.id, q, action);
      expect(r.status, action).toBe(403);
      expect(r.body.error.code).toBe("help_not_available_yet");
    }
    expect(await events(s.id)).toHaveLength(0);

    const calls = model(ok("small_hint", { citedSegmentIds: [seg.id], sourceSupported: true }));
    const hint = await ask(s.id, q, "small_hint");
    expect(hint.status).toBe(200);
    expect(calls[0]!.prompt).not.toContain(seg.id);
    expect(hint.body.help).toMatchObject({ pass: 2, citations: [], sourceSupported: false });

    model(ok("why_wrong", { text: "You picked the structure that removes the newest item." }));
    const why = await ask(s.id, q, "why_wrong");
    expect(why.status).toBe(200);
    expect(why.body.help.pass).toBe(2);

    // Help on the retry is checked for leaks like a small hint.
    model(ok("why_wrong", { text: "The correct answer is a queue." }));
    expect((await ask(s.id, q, "why_wrong")).body.error.code).toBe("ai_invalid_output");

    // The events belong to the retry, and the retry attempt is the one that claims them.
    const retry = await answer(s.id, q, "b", 2);
    expect(retry.body.result.disclosure).toBe("full");
    const [second] = await db.select().from(attempts).where(eq(attempts.pass, 2));
    expect(second!.assistanceLevel).toBe("next_step_hint");
  });

  it("refuses help in exams and in end-reveal sessions", async () => {
    const { set } = await makeSet(2);
    const [examRow] = await db
      .insert(studySessions)
      .values({
        userId: alice.id,
        courseId,
        questionSetId: set.id,
        mode: "exam",
        state: "active",
        revealMode: "end",
        itemOrder: [],
        revisionIds: {},
        startedAt: new Date(),
        activeStartedAt: new Date(),
      })
      .returning();
    model(ok("small_hint"));
    const exam = await ask(examRow!.id, randomUUID(), "small_hint");
    expect(exam.status).toBe(403);
    expect(exam.body.error.code).toBe("help_disabled_in_exam");

    const s = await session("end");
    const end = await ask(s.id, s.order[0]!, "small_hint");
    expect(end.status).toBe(403);
    expect(end.body.error.code).toBe("help_disabled_in_session");
    expect(await events(s.id)).toHaveLength(0);
  });
});

describe("when the model cannot be used", () => {
  async function approve(
    questionId: string,
    level: (typeof approvedHints.$inferInsert)["level"],
    text: string,
    evidenceStatus: (typeof approvedHints.$inferInsert)["evidenceStatus"] = "human_reviewed",
    sourceSegmentIds: string[] = [],
  ) {
    const [hint] = await db
      .insert(approvedHints)
      .values({
        questionRevisionId: await revisionOf(questionId),
        level,
        text,
        origin: "owner",
        evidenceStatus,
        sourceSegmentIds,
      })
      .returning();
    return hint!;
  }

  it("serves a reviewed hint when AI is off, labelled as approved", async () => {
    const s = await session();
    const q = s.order[0]!;
    const hint = await approve(q, "conceptual_hint", "Think about the order items leave.");
    // No provider is set: the default is disabled.
    const r = await ask(s.id, q, "small_hint");
    expect(r.status).toBe(200);
    expect(r.body.help).toMatchObject({
      text: "Think about the order items leave.",
      origin: "approved",
      servedAs: "requested",
      level: "conceptual_hint",
    });
    const [event] = await events(s.id);
    expect(event).toMatchObject({ approvedHintId: hint.id, contentText: null, provider: null });
  });

  it("falls back to a weaker reviewed hint on failures, and says it is a fallback", async () => {
    const s = await session();
    const q = s.order[0]!;
    const hint = await approve(q, "conceptual_hint", "Think about the order items leave.");
    for (const error of [
      new AiTimeout(),
      new AiQuotaExceeded(),
      new AiUnavailable(),
      new Error("boom"),
    ]) {
      failing(error);
      const r = await ask(s.id, q, "explain_step");
      expect(r.status).toBe(200);
      expect(r.body.help).toMatchObject({
        servedAs: "fallback_hint",
        origin: "approved",
        level: "conceptual_hint",
      });
    }
    expect((await events(s.id))[0]!.approvedHintId).toBe(hint.id);
  });

  it("labels a generic hint served for 'why was I wrong' as a fallback, never as a diagnosis", async () => {
    const s = await session();
    const q = s.order[0]!;
    await approve(q, "conceptual_hint", "Think about the order items leave.");
    await answer(s.id, q, "a");
    // Reach the same question again in a new session: the student has a wrong answer on record.
    await db.update(studySessions).set({ state: "abandoned" }).where(eq(studySessions.id, s.id));
    const again = await startOrResumeSession(db, alice.id, s.set.id, "each");
    const current = again.session.items[0]!.questionId;
    failing(new AiTimeout());
    if (current !== q) await answer(again.session.id, current, "b");
    const r = await ask(again.session.id, q, "why_wrong");
    expect(r.status).toBe(200);
    expect(r.body.help).toMatchObject({ servedAs: "fallback_hint", origin: "approved" });
  });

  it("does not serve hints that are not reviewed, too strong, or leak", async () => {
    const s = await session();
    const q = s.order[0]!;
    await approve(q, "conceptual_hint", "AI draft hint.", "needs_review");
    await approve(q, "next_step_hint", "Generated, unchecked hint.", "generated_unreviewed");
    await approve(q, "full_explanation", "The answer is a queue.", "human_reviewed");
    failing(new AiUnavailable());
    const r = await ask(s.id, q, "small_hint");
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("ai_unavailable");
    expect(await events(s.id)).toHaveLength(0);
  });

  it("does not show a reviewed small hint that states the answer", async () => {
    const s = await session();
    const q = s.order[0]!;
    await approve(q, "conceptual_hint", "Pick option B.");
    failing(new AiUnavailable());
    expect((await ask(s.id, q, "small_hint")).status).toBe(503);
  });

  it("skips a reviewed hint whose cited passage is no longer readable", async () => {
    const s = await session();
    const q = s.order[0]!;
    const foreign = await passage(bob.id, bobCourseId, "Not yours.");
    await approve(q, "conceptual_hint", "Hint citing a passage.", "human_reviewed", [foreign.id]);
    const r = await ask(s.id, q, "small_hint");
    expect(r.status).toBe(503);
  });

  it("returns a safe error and leaves the work alone when there is no reviewed hint", async () => {
    const s = await session();
    const q = s.order[0]!;
    failing(new Error("Bearer sk-secret-token leaked from provider"));
    const r = await ask(s.id, q, "small_hint");
    expect(r.status).toBe(503);
    expect(r.text).not.toMatch(/sk-secret|Bearer|stack|key-from-test/i);
    expect(await events(s.id)).toHaveLength(0);
    expect(await db.select().from(attempts).where(eq(attempts.sessionId, s.id))).toHaveLength(0);
    // The student can still answer.
    expect((await answer(s.id, q, "b")).status).toBe(201);
  });

  it("prefers a reviewed hint of the exact strength and skips the model", async () => {
    const s = await session();
    const q = s.order[0]!;
    await approve(q, "conceptual_hint", "Think about the order items leave.");
    const calls = model(ok("small_hint"));
    const r = await ask(s.id, q, "small_hint");
    expect(r.body.help.origin).toBe("approved");
    expect(calls).toHaveLength(0);
  });
});

describe("requests", () => {
  it("validates the body, requires sign-in, and hides other users' sessions", async () => {
    const s = await session();
    const q = s.order[0]!;
    model(ok("small_hint"));
    expect((await help(s.id, { questionId: q, action: "small_hint" }, null)).status).toBe(401);
    expect((await help(s.id, { questionId: q, action: "reveal" })).status).toBe(400);
    expect((await help(s.id, { questionId: "nope", action: "small_hint" })).status).toBe(400);
    // The client cannot choose the pass or the level.
    expect((await help(s.id, { questionId: q, action: "small_hint", pass: 2 })).status).toBe(400);
    expect((await help(s.id, { questionId: q, action: "small_hint", level: "none" })).status).toBe(
      400,
    );
    expect((await ask(s.id, q, "small_hint", bob)).status).toBe(404);
    expect((await help(randomUUID(), { questionId: q, action: "small_hint" })).status).toBe(404);
    expect(await events(s.id)).toHaveLength(0);
  });

  it("refuses a question that is not the current one, and ended or paused sessions", async () => {
    const s = await session();
    model(ok("small_hint"));
    const later = await ask(s.id, s.order[1]!, "small_hint");
    expect(later.status).toBe(409);
    expect(later.body.error.code).toBe("stale_turn");
    expect((await ask(s.id, randomUUID(), "small_hint")).status).toBe(409);

    await pauseSession(db, alice.id, s.id);
    expect((await ask(s.id, s.order[0]!, "small_hint")).body.error.code).toBe("session_paused");

    const done = await session();
    await call(
      (await import("@/app/api/sessions/[sessionId]/complete/route")).POST,
      "/api/x",
      alice,
      {
        body: {},
        params: { sessionId: done.id },
      },
    );
    expect((await ask(done.id, done.order[0]!, "small_hint")).body.error.code).toBe(
      "session_completed",
    );
  });

  it("streams only the validated text, then the full record", async () => {
    const s = await session();
    const q = s.order[0]!;
    const long = "Think about the order items leave. ".repeat(10);
    model(ok("small_hint", { text: long }));
    const r = await call(helpPost, "/api/x", alice, {
      body: { questionId: q, action: "small_hint" },
      params: { sessionId: s.id },
      headers: { accept: "text/event-stream" },
    });
    expect(r.status).toBe(200);
    const chunks = [...r.text.matchAll(/event: text\ndata: (.*)\n/g)].map(
      (m) => JSON.parse(m[1]!).text,
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("").trim()).toBe(long.trim());
    expect(r.text).toMatch(/event: done\ndata: .*"servedAs":"requested"/);

    // A rejected answer streams nothing: the error is an ordinary JSON response.
    model(ok("small_hint", { text: "It is a queue." }));
    const bad = await call(helpPost, "/api/x", alice, {
      body: { questionId: q, action: "small_hint" },
      params: { sessionId: s.id },
      headers: { accept: "text/event-stream" },
    });
    expect(bad.status).toBe(502);
    expect(bad.text).not.toContain("event: text");
  });
});
