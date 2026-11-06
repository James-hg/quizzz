import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.AUTH_RATE_LIMIT_MAX = "1000";

import { POST as chatPost } from "@/app/api/ai/chat/route";
import { GET as consentGet, POST as consentPost } from "@/app/api/ai/consent/route";
import { POST as generatePost } from "@/app/api/ai/question-sets/[setId]/generate-questions/route";
import { POST as savePost } from "@/app/api/ai/question-sets/[setId]/save-proposals/route";
import { POST as titlePost } from "@/app/api/ai/question-sets/[setId]/suggest-title/route";
import { POST as rewritePost } from "@/app/api/ai/questions/[questionId]/rewrite/route";
import { GET as coursesGet } from "@/app/api/courses/route";
import { AI_NOTICE_VERSION } from "@/lib/ai-consent";
import { createCourse } from "@/server/content/courses";
import { createQuestion } from "@/server/content/questions";
import { createQuestionSet } from "@/server/content/question-sets";
import { getDb } from "@/server/db";
import { aiCallLogs, aiConsents, aiUsage } from "@/server/db/schema";
import { resetAiState } from "@/test/ai-state";
import { authRequest } from "@/test/auth-helpers";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { setAiProviderForTesting } from "./index";
import type { AiProvider } from "./provider";
import { acceptCurrentAiConsent, hasCurrentAiConsent } from "./consent";

const db = getDb();
let alice: TestUser;
let bob: TestUser;
let setId: string;
let questionId: string;
let providerCalls = 0;

const provider: AiProvider = {
  name: "fake",
  generateText: async () => {
    providerCalls++;
    return "hello";
  },
  generateStructured: async () => {
    providerCalls++;
    throw new Error("not needed");
  },
  async *streamText() {
    providerCalls++;
    yield "x";
  },
};

async function call(
  handler: unknown,
  options: { body?: unknown; as?: TestUser | null; params?: Record<string, string> } = {},
) {
  const who = options.as === undefined ? alice : options.as;
  const request = authRequest("/x", {
    method: options.body === undefined ? "GET" : "POST",
    body: options.body,
    cookie: who?.cookie,
  });
  const response = await (
    handler as (r: Request, c: { params: Promise<never> }) => Promise<Response>
  )(request, { params: Promise.resolve((options.params ?? {}) as never) });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

const modelRoutes = () =>
  [
    ["chat", () => call(chatPost, { body: { message: "hi" } })],
    ["generate", () => call(generatePost, { body: { count: 1 }, params: { setId } })],
    ["title", () => call(titlePost, { body: {}, params: { setId } })],
    ["rewrite", () => call(rewritePost, { body: { mode: "rephrase" }, params: { questionId } })],
  ] as const;

beforeAll(async () => {
  alice = await signUpUser(db);
  bob = await signUpUser(db);
  const course = await createCourse(db, alice.id, { title: "C", subject: "S" });
  setId = (await createQuestionSet(db, alice.id, course.id, "Set")).id;
  questionId = (
    await createQuestion(
      db,
      alice.id,
      setId,
      {
        type: "mcq_single",
        prompt: "Pick one",
        options: [
          { id: "a", text: "x" },
          { id: "b", text: "y" },
        ],
        correctOptionIds: ["a"],
      },
      false,
    )
  ).id;
});
beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  providerCalls = 0;
  setAiProviderForTesting(provider);
  await resetAiState(db);
  await db.delete(aiConsents).where(eq(aiConsents.userId, alice.id));
  await db.delete(aiConsents).where(eq(aiConsents.userId, bob.id));
  await db.delete(aiUsage).where(eq(aiUsage.userId, alice.id));
});
afterEach(() => {
  setAiProviderForTesting(undefined);
  vi.restoreAllMocks();
});
afterAll(async () => {
  await resetAiState(db);
  await deleteUsers(db, [alice.id, bob.id]);
});

describe("consent service", () => {
  it("records acceptance once per user and version and keeps the first time", async () => {
    expect(await hasCurrentAiConsent(db, alice.id)).toBe(false);
    await acceptCurrentAiConsent(db, alice.id);
    const [first] = await db.select().from(aiConsents).where(eq(aiConsents.userId, alice.id));
    await acceptCurrentAiConsent(db, alice.id);
    const rows = await db.select().from(aiConsents).where(eq(aiConsents.userId, alice.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.acceptedAt).toEqual(first?.acceptedAt);
    expect(await hasCurrentAiConsent(db, alice.id)).toBe(true);
    expect(await hasCurrentAiConsent(db, bob.id)).toBe(false);
  });

  it("does not count an older notice version", async () => {
    await db.insert(aiConsents).values({ userId: alice.id, noticeVersion: "2020-01-01-v0" });
    expect(await hasCurrentAiConsent(db, alice.id)).toBe(false);
  });

  it("removes consent rows with the user", async () => {
    const temp = await signUpUser(db);
    await acceptCurrentAiConsent(db, temp.id);
    await deleteUsers(db, [temp.id]);
    expect(await db.select().from(aiConsents).where(eq(aiConsents.userId, temp.id))).toHaveLength(
      0,
    );
  });
});

describe("model routes", () => {
  it.each(modelRoutes())("%s returns consent_required and does nothing else", async (_n, run) => {
    const r = await run();
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("consent_required");
    expect(r.body.error.details).toEqual({ noticeVersion: AI_NOTICE_VERSION });
    expect(providerCalls).toBe(0);
    expect(await db.select().from(aiUsage).where(eq(aiUsage.userId, alice.id))).toHaveLength(0);
    expect(await db.select().from(aiCallLogs).where(eq(aiCallLogs.userId, alice.id))).toHaveLength(
      0,
    );
  });

  it("reaches the provider once the user has accepted", async () => {
    await acceptCurrentAiConsent(db, alice.id);
    const r = await call(chatPost, { body: { message: "hi" } });
    expect(r.status).toBe(200);
    expect(providerCalls).toBe(1);
  });

  it("asks again after a notice version bump", async () => {
    await db.insert(aiConsents).values({ userId: alice.id, noticeVersion: "2020-01-01-v0" });
    expect((await call(chatPost, { body: { message: "hi" } })).body.error.code).toBe(
      "consent_required",
    );
  });

  it("keeps consent per user", async () => {
    await acceptCurrentAiConsent(db, alice.id);
    const asBob = await call(chatPost, { body: { message: "hi" }, as: bob });
    expect(asBob.body.error.code).toBe("consent_required");
  });

  it("keeps 401 for signed-out users and 503 when AI is off, before the consent check", async () => {
    expect((await call(chatPost, { body: { message: "hi" }, as: null })).status).toBe(401);
    setAiProviderForTesting(undefined);
    const off = await call(chatPost, { body: { message: "hi" } });
    expect(off.status).toBe(503);
    expect(off.body.error.code).toBe("ai_unavailable");
  });

  it("does not gate saving proposals or ordinary routes", async () => {
    const saved = await call(savePost, { body: { proposals: [] }, params: { setId } });
    expect(saved.body?.error?.code).not.toBe("consent_required");
    expect((await call(coursesGet)).status).toBe(200);
  });
});

describe("consent route", () => {
  it("reports status privately, then records acceptance", async () => {
    const before = await call(consentGet);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ noticeVersion: AI_NOTICE_VERSION, accepted: false });
    expect(before.body.notice.termsUrl).toBe("https://ai.google.dev/gemini-api/terms");
    expect(before.headers.get("cache-control")).toBe("private, no-store");

    const accepted = await call(consentPost, {
      body: { noticeVersion: AI_NOTICE_VERSION, accepted: true },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.accepted).toBe(true);
    expect((await call(consentGet, { as: bob })).body.accepted).toBe(false);
    // Accepting twice is harmless.
    expect(
      (await call(consentPost, { body: { noticeVersion: AI_NOTICE_VERSION, accepted: true } }))
        .status,
    ).toBe(200);
  });

  it("refuses a stale version, a decline, extra fields and signed-out callers", async () => {
    const stale = await call(consentPost, { body: { noticeVersion: "old", accepted: true } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("notice_version_changed");
    expect(stale.body.error.details.noticeVersion).toBe(AI_NOTICE_VERSION);
    for (const body of [
      { noticeVersion: AI_NOTICE_VERSION, accepted: false },
      { noticeVersion: AI_NOTICE_VERSION, accepted: true, userId: bob.id },
      {},
    ]) {
      expect((await call(consentPost, { body })).status).toBe(400);
    }
    expect(
      (
        await call(consentPost, {
          body: { noticeVersion: AI_NOTICE_VERSION, accepted: true },
          as: null,
        })
      ).status,
    ).toBe(401);
    expect(await db.select().from(aiConsents).where(eq(aiConsents.userId, bob.id))).toHaveLength(0);
    expect(await hasCurrentAiConsent(db, alice.id)).toBe(false);
  });
});
