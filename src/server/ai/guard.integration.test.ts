import { asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

process.env.AUTH_RATE_LIMIT_MAX = "1000";
process.env.AI_REQUESTS_PER_MINUTE = "3";
process.env.AI_MAX_INPUT_CHARS = "500";
process.env.AI_MAX_OUTPUT_TOKENS = "200";

import { POST as chatPost } from "@/app/api/ai/chat/route";
import { GET as statusGet } from "@/app/api/ai/status/route";
import { GET as coursesGet } from "@/app/api/courses/route";
import { getDb } from "@/server/db";
import { aiCallLeases, aiCallLogs, aiRateWindows, aiUsage } from "@/server/db/schema";
import { resetAiState } from "@/test/ai-state";
import { authRequest } from "@/test/auth-helpers";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { AiInputTooLarge, AiPaused, AiQuotaExceeded } from "./errors";
import { withAiOperation } from "./guard";
import { setAiProviderForTesting } from "./index";
import type { AiProvider, GenerateOptions } from "./provider";
import { GeminiProvider } from "./gemini";

const db = getDb();
let alice: TestUser;

type Behaviour = (options: GenerateOptions | undefined) => Promise<unknown> | unknown;

/** A provider whose answers come from `behave`. Records the options each call received. */
function fake(
  behave: Behaviour = () => "ok",
  usage?: { inputTokens?: number; outputTokens?: number },
) {
  const calls: (GenerateOptions | undefined)[] = [];
  const run = async (options: GenerateOptions | undefined) => {
    calls.push(options);
    const value = await behave(options);
    if (usage) options?.onUsage?.(usage);
    return value;
  };
  const provider: AiProvider = {
    name: "fake",
    model: "fake-model",
    generateText: async (_input, options) => (await run(options)) as string,
    generateStructured: async (_input, _schema, options) => (await run(options)) as never,
    async *streamText(_input, options) {
      calls.push(options);
      yield "a";
      yield "b";
      options?.onUsage?.({ inputTokens: 3, outputTokens: 2 });
    },
  };
  return { provider, calls };
}

const op = <T>(provider: AiProvider, run: (p: AiProvider) => Promise<T>) =>
  withAiOperation(db, { userId: alice.id, route: "chat" }, provider, run);
const logs = () =>
  db
    .select()
    .from(aiCallLogs)
    .where(eq(aiCallLogs.userId, alice.id))
    .orderBy(asc(aiCallLogs.startedAt));

beforeAll(async () => {
  alice = await signUpUser(db);
});
beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetAiState(db);
  await db.delete(aiUsage).where(eq(aiUsage.userId, alice.id));
});
afterEach(() => {
  setAiProviderForTesting(undefined);
  vi.restoreAllMocks();
});
afterAll(async () => {
  await resetAiState(db);
  await deleteUsers(db, [alice.id]);
});

describe("withAiOperation", () => {
  it("logs each provider call and releases the lease", async () => {
    const { provider } = fake(() => "hello");
    await expect(op(provider, (p) => p.generateText("hi"))).resolves.toBe("hello");
    const [row] = await logs();
    expect(row).toMatchObject({
      route: "chat",
      model: "fake-model",
      method: "generateText",
      outcome: "success",
      inputTokens: null,
      outputTokens: null,
    });
    expect(row?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(row?.finishedAt).not.toBeNull();
    expect(await db.select().from(aiCallLeases)).toHaveLength(0);
  });

  it("records reported tokens, summed, and null when none are reported", async () => {
    const { provider } = fake(() => ({}), { inputTokens: 10, outputTokens: 4 });
    await op(provider, async (p) => {
      await p.generateStructured("a", z.object({}));
      await p.generateStructured("b", z.object({}));
    });
    const rows = await logs();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.method, r.inputTokens, r.outputTokens])).toEqual([
      ["generateStructured", 10, 4],
      ["generateStructured", 10, 4],
    ]);
    // Only one operation was counted, even with two provider calls.
    const [hour] = await db.select().from(aiUsage).where(eq(aiUsage.userId, alice.id));
    expect(hour?.count).toBe(1);
  });

  it("keeps an explicit zero apart from unknown", async () => {
    const { provider } = fake(() => "x", { inputTokens: 0 });
    await op(provider, (p) => p.generateText("hi"));
    const [row] = await logs();
    expect([row?.inputTokens, row?.outputTokens]).toEqual([0, null]);
  });

  it("logs a stream across the whole iteration and its reported tokens", async () => {
    const { provider } = fake();
    const seen: string[] = [];
    await op(provider, async (p) => {
      for await (const chunk of p.streamText("hi")) seen.push(chunk);
    });
    expect(seen).toEqual(["a", "b"]);
    const [row] = await logs();
    expect(row).toMatchObject({
      method: "streamText",
      outcome: "success",
      inputTokens: 3,
      outputTokens: 2,
    });
    expect(await db.select().from(aiCallLeases)).toHaveLength(0);
  });

  it("logs a stream the reader abandoned as cancelled", async () => {
    const { provider } = fake();
    await op(provider, async (p) => {
      for await (const chunk of p.streamText("hi")) {
        void chunk;
        break;
      }
    });
    expect((await logs())[0]?.outcome).toBe("cancelled");
    expect(await db.select().from(aiCallLeases)).toHaveLength(0);
  });

  it("maps failures to outcomes and still releases the lease", async () => {
    const { provider } = fake(() => {
      throw new Error("boom");
    });
    await expect(op(provider, (p) => p.generateText("hi"))).rejects.toThrow("boom");
    expect((await logs())[0]?.outcome).toBe("unavailable");
    expect(await db.select().from(aiCallLeases)).toHaveLength(0);
  });

  it("refuses oversized input before any quota or log is used", async () => {
    const { provider, calls } = fake();
    await expect(
      op(provider, (p) => p.generateText("x".repeat(400), { system: "y".repeat(200) })),
    ).rejects.toBeInstanceOf(AiInputTooLarge);
    expect(calls).toHaveLength(0);
    expect(await logs()).toHaveLength(0);
    expect(await db.select().from(aiUsage).where(eq(aiUsage.userId, alice.id))).toHaveLength(0);
  });

  it("caps the requested output tokens and gives every call a deadline signal", async () => {
    const { provider, calls } = fake();
    await op(provider, async (p) => {
      await p.generateText("hi", { maxOutputTokens: 4096 });
      await p.generateText("hi");
    });
    expect(calls.map((c) => c?.maxOutputTokens)).toEqual([200, 200]);
    expect(calls.every((c) => c?.signal instanceof AbortSignal)).toBe(true);
  });

  it("does not call the provider when the log cannot be written", async () => {
    const { provider, calls } = fake();
    const original = db.insert.bind(db);
    const spy = vi.spyOn(db, "insert").mockImplementation(((table: never) => {
      if (table === aiCallLogs) throw new Error("db down");
      return original(table);
    }) as never);
    await expect(op(provider, (p) => p.generateText("hi"))).rejects.toThrow("db down");
    spy.mockRestore();
    expect(calls).toHaveLength(0);
    expect(await db.select().from(aiCallLeases)).toHaveLength(0);
  });
});

describe("quota pause end to end", () => {
  it("pauses after two quota errors, blocks the third call, and recovers after the cooldown", async () => {
    const { provider, calls } = fake(() => {
      throw new AiQuotaExceeded();
    });
    for (let i = 0; i < 2; i++) {
      await expect(op(provider, (p) => p.generateText("hi"))).rejects.toBeInstanceOf(
        AiQuotaExceeded,
      );
    }
    await expect(op(provider, (p) => p.generateText("hi"))).rejects.toBeInstanceOf(AiPaused);
    expect(calls).toHaveLength(2);
    expect((await logs()).map((r) => r.outcome)).toEqual(["quota", "quota"]);

    // Pretend the cooldown passed.
    await db.execute(sql`update ai_provider_state set paused_until = now() - interval '1 second'`);
    await db.delete(aiRateWindows);
    const healthy = fake(() => "back");
    await expect(op(healthy.provider, (p) => p.generateText("hi"))).resolves.toBe("back");
    await expect(op(healthy.provider, (p) => p.generateText("hi"))).resolves.toBe("back");
  });
});

describe("routes", () => {
  const get = async (handler: unknown, user: TestUser | null = alice) => {
    const response = await (handler as (r: Request) => Promise<Response>)(
      authRequest("/x", { cookie: user?.cookie }),
    );
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const chat = async (message = "hi") => {
    const response = await chatPost(
      authRequest("/x", { method: "POST", body: { message }, cookie: alice.cookie }),
    );
    return { status: response.status, body: await response.json() };
  };

  function useGemini(status: number, text = "hello") {
    const fetchMock = vi.fn().mockImplementation(async () =>
      status === 200
        ? new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text }] } }],
              usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
            }),
            { status },
          )
        : new Response("{}", { status }),
    );
    setAiProviderForTesting(
      new GeminiProvider({ apiKey: "k", model: "gemini-test", fetch: fetchMock as never }),
    );
    return fetchMock;
  }

  it("returns a friendly 429 over the per-user minute cap, and practice routes still work", async () => {
    useGemini(200);
    for (let i = 0; i < 3; i++) expect((await chat()).status).toBe(200);
    const limited = await chat();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("ai_rate_limited");
    expect(limited.body.error.message).toMatch(/too quickly/);
    expect(limited.body.error.details.retryAt).toEqual(expect.any(String));
    expect((await get(coursesGet)).status).toBe(200);
    // The real Gemini adapter reported tokens, which landed in the log.
    expect((await logs())[0]).toMatchObject({
      model: "gemini-test",
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  it("flips to paused after repeated provider 429s, and practice keeps working", async () => {
    const fetchMock = useGemini(429);
    expect((await get(statusGet)).body.state).toBe("available");
    expect((await chat()).body.error.code).toBe("ai_quota_exceeded");
    expect((await chat()).body.error.code).toBe("ai_quota_exceeded");

    const third = await chat();
    expect(third.status).toBe(503);
    expect(third.body.error.code).toBe("ai_paused");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const status = await get(statusGet);
    expect(status.body).toMatchObject({ state: "paused", retryAt: expect.any(String) });
    expect(status.headers.get("cache-control")).toBe("private, no-store");
    expect((await get(coursesGet)).status).toBe(200);
  });

  it("reports disabled, requires sign-in, and leaks nothing", async () => {
    expect((await get(statusGet, null)).status).toBe(401);
    const status = await get(statusGet);
    expect(status.body.state).toBe("disabled");
    expect(JSON.stringify(status.body)).not.toMatch(/key|count/i);
  });
});
