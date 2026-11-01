import { resetAiState } from "@/test/ai-state";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.AI_REQUESTS_PER_HOUR = "30";
process.env.AUTH_RATE_LIMIT_MAX = "1000";

import { POST as rewritePost } from "@/app/api/ai/questions/[questionId]/rewrite/route";
import {
  GET as rewritesGet,
  POST as rewritesPost,
} from "@/app/api/questions/[questionId]/rewrites/route";
import { GET as questionGet } from "@/app/api/questions/[questionId]/route";
import { POST as acceptPost } from "@/app/api/rewrites/[rewriteId]/accept/route";
import { POST as dismissPost } from "@/app/api/rewrites/[rewriteId]/dismiss/route";
import { call } from "@/test/api";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { createCourse } from "@/server/content/courses";
import { createQuestion, listPlayableItems } from "@/server/content/questions";
import { createQuestionSet } from "@/server/content/question-sets";
import { getDb } from "@/server/db";
import type { QuestionContent } from "@/lib/schemas";
import { GeminiProvider } from "./gemini";
import { setAiProviderForTesting } from "./index";

const db = getDb();
let alice: TestUser;
let bob: TestUser;
let setId: string;

const base: QuestionContent = {
  type: "mcq_single",
  prompt: "What is 3 + 4?",
  options: [
    { id: "a", text: "7" },
    { id: "b", text: "8" },
    { id: "c", text: "12" },
  ],
  correctOptionIds: ["a"],
};

beforeAll(async () => {
  alice = await signUpUser(db);
  bob = await signUpUser(db);
  const course = await createCourse(db, alice.id, { title: "CS", subject: "Math" });
  setId = (await createQuestionSet(db, alice.id, course.id, "Flow")).id;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  setAiProviderForTesting(undefined);
  await resetAiState(db);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await deleteUsers(db, [alice.id, bob.id]);
});

function useModel(reply: unknown) {
  setAiProviderForTesting(
    new GeminiProvider({
      apiKey: "key-from-test",
      model: "gemini-test",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    }),
  );
}

describe("the whole flow over HTTP", () => {
  it("propose, save, list, accept (confirmed), retry, and the question is updated once", async () => {
    const q = await createQuestion(db, alice.id, setId, base, false);
    useModel({ explanation: "3 + 4 equals 7." });

    const proposed = await call(rewritePost, "/x", alice, {
      body: { mode: "add_explanation" },
      params: { questionId: q.id },
    });
    expect(proposed.status).toBe(200);
    const { proposal } = proposed.body;

    // Saving needs no AI: it works with AI switched off.
    setAiProviderForTesting(undefined);
    const saved = await call(rewritesPost, "/x", alice, {
      body: {
        mode: proposal.mode,
        baseRevisionId: proposal.baseRevisionId,
        content: proposal.content,
      },
      params: { questionId: q.id },
    });
    expect(saved.status).toBe(201);
    const rewriteId = saved.body.rewrite.id as string;
    expect(saved.body.rewrite).toMatchObject({
      mode: "add_explanation",
      origin: "ai_proposed",
      stale: false,
    });

    const listed = await call(rewritesGet, "/x", alice, { params: { questionId: q.id } });
    expect(listed.body.rewrites.map((r: { id: string }) => r.id)).toEqual([rewriteId]);

    // Still the original, and still practisable.
    const before = await call(questionGet, "/x", alice, { params: { questionId: q.id } });
    expect(before.body.question).toMatchObject({ revisionNumber: 1, explanation: null });
    expect(await listPlayableItems(db, setId)).toHaveLength(1);

    const unconfirmed = await call(acceptPost, "/x", alice, { body: {}, params: { rewriteId } });
    expect(unconfirmed.status).toBe(400);
    const notTrue = await call(acceptPost, "/x", alice, {
      body: { confirmed: false },
      params: { rewriteId },
    });
    expect(notTrue.status).toBe(400);

    const accepted = await call(acceptPost, "/x", alice, {
      body: { confirmed: true },
      params: { rewriteId },
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.question).toMatchObject({
      revisionNumber: 2,
      explanation: "3 + 4 equals 7.",
      evidenceStatus: "human_reviewed",
      origin: "ai_proposed",
    });

    const again = await call(acceptPost, "/x", alice, {
      body: { confirmed: true },
      params: { rewriteId },
    });
    expect(again.status).toBe(200);
    expect(again.body.question.revisionNumber).toBe(2);
    const after = await call(rewritesGet, "/x", alice, { params: { questionId: q.id } });
    expect(after.body.rewrites).toEqual([]);
  });

  it("rejects a proposal that does not fit the question when saving", async () => {
    const q = await createQuestion(db, alice.id, setId, base, false);
    const res = await call(rewritesPost, "/x", alice, {
      body: {
        mode: "rephrase",
        baseRevisionId: q.revisionId,
        content: { ...base, prompt: "Work out 3 plus 4.", correctOptionIds: ["b"] },
      },
      params: { questionId: q.id },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_proposal");
  });

  it("dismisses a proposal, and then it can no longer be accepted", async () => {
    const q = await createQuestion(db, alice.id, setId, base, false);
    const saved = await call(rewritesPost, "/x", alice, {
      body: {
        mode: "add_explanation",
        baseRevisionId: q.revisionId,
        content: { ...base, explanation: "Because." },
      },
      params: { questionId: q.id },
    });
    const rewriteId = saved.body.rewrite.id as string;
    expect(
      (await call(dismissPost, "/x", alice, { method: "POST", params: { rewriteId } })).status,
    ).toBe(204);
    expect(
      (await call(dismissPost, "/x", alice, { method: "POST", params: { rewriteId } })).status,
    ).toBe(204);
    const accepted = await call(acceptPost, "/x", alice, {
      body: { confirmed: true },
      params: { rewriteId },
    });
    expect(accepted.status).toBe(409);
    expect(accepted.body.error.code).toBe("already_resolved");
  });

  it("is private on every route: no session is 401, another user's ids are 404", async () => {
    const q = await createQuestion(db, alice.id, setId, base, false);
    const saved = await call(rewritesPost, "/x", alice, {
      body: {
        mode: "add_explanation",
        baseRevisionId: q.revisionId,
        content: { ...base, explanation: "Because." },
      },
      params: { questionId: q.id },
    });
    const rewriteId = saved.body.rewrite.id as string;
    const body = {
      mode: "add_explanation",
      baseRevisionId: q.revisionId,
      content: { ...base, explanation: "Because." },
    };

    const cases: [string, Promise<{ status: number }>, Promise<{ status: number }>][] = [
      [
        "list",
        call(rewritesGet, "/x", null, { params: { questionId: q.id } }),
        call(rewritesGet, "/x", bob, { params: { questionId: q.id } }),
      ],
      [
        "save",
        call(rewritesPost, "/x", null, { body, params: { questionId: q.id } }),
        call(rewritesPost, "/x", bob, { body, params: { questionId: q.id } }),
      ],
      [
        "accept",
        call(acceptPost, "/x", null, { body: { confirmed: true }, params: { rewriteId } }),
        call(acceptPost, "/x", bob, { body: { confirmed: true }, params: { rewriteId } }),
      ],
      [
        "dismiss",
        call(dismissPost, "/x", null, { method: "POST", params: { rewriteId } }),
        call(dismissPost, "/x", bob, { method: "POST", params: { rewriteId } }),
      ],
    ];
    for (const [name, anonymous, stranger] of cases) {
      expect((await anonymous).status, `${name} without a session`).toBe(401);
      expect((await stranger).status, `${name} as another user`).toBe(404);
    }
    // The proposal is untouched by the failed attempts.
    const still = await call(rewritesGet, "/x", alice, { params: { questionId: q.id } });
    expect(still.body.rewrites.map((r: { id: string }) => r.id)).toContain(rewriteId);
  });
});
