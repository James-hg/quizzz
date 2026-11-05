import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GeminiProvider } from "./gemini";
import { createProvider, DEFAULT_GEMINI_MODEL } from "./index";
import { AiInvalidOutput, AiQuotaExceeded, AiTimeout, AiUnavailable } from "./errors";

const KEY = "test-key-SECRET-123";
const schema = z.object({ title: z.string().min(1) });

const reply = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const failure = (status: number, apiStatus = "ERR") =>
  new Response(JSON.stringify({ error: { status: apiStatus, message: "details" } }), { status });

function provider(fetchImpl: typeof fetch) {
  return new GeminiProvider({ apiKey: KEY, model: "gemini-test", fetch: fetchImpl });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("GeminiProvider.generateText", () => {
  it("sends the key in a header, never in the URL, and returns the text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(reply("Hello")));
    const text = await provider(fetchMock).generateText("Hi", {
      system: "Be brief",
      maxOutputTokens: 50,
      temperature: 0.2,
    });
    expect(text).toBe("Hello");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent",
    );
    expect(String(url)).not.toContain(KEY);
    expect(init.headers["x-goog-api-key"]).toBe(KEY);
    const body = JSON.parse(init.body);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Hi" }] }]);
    expect(body.systemInstruction.parts[0].text).toBe("Be brief");
    expect(body.generationConfig).toEqual({ maxOutputTokens: 50, temperature: 0.2 });
  });

  it("maps assistant turns to the model role", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(reply("x")));
    await provider(fetchMock).generateText([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
  });

  it("maps 429 to ai_quota_exceeded", async () => {
    const p = provider(vi.fn().mockResolvedValue(failure(429, "RESOURCE_EXHAUSTED")));
    await expect(p.generateText("hi")).rejects.toBeInstanceOf(AiQuotaExceeded);
    await expect(p.generateText("hi")).rejects.toMatchObject({
      status: 429,
      code: "ai_quota_exceeded",
    });
  });

  it.each([400, 401, 403, 404, 500, 503])("maps HTTP %i to ai_unavailable", async (status) => {
    const p = provider(vi.fn().mockResolvedValue(failure(status)));
    await expect(p.generateText("hi")).rejects.toMatchObject({
      status: 503,
      code: "ai_unavailable",
    });
  });

  it("maps network failures to ai_unavailable without leaking details", async () => {
    const p = provider(vi.fn().mockRejectedValue(new TypeError("fetch failed " + KEY)));
    const error = await p.generateText("hi").catch((e) => e);
    expect(error).toBeInstanceOf(AiUnavailable);
    expect(error.message).not.toContain(KEY);
  });

  it("never logs the key", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await provider(vi.fn().mockResolvedValue(failure(403)))
      .generateText("x")
      .catch(() => {});
    expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
  });

  it("honors the timeout", async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    await expect(
      provider(hang as unknown as typeof fetch).generateText("hi", { timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(AiTimeout);
  });

  it("passes caller cancellation through as an abort, not a timeout", async () => {
    const controller = new AbortController();
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const pending = provider(hang as unknown as typeof fetch).generateText("hi", {
      signal: controller.signal,
      timeoutMs: 5000,
    });
    controller.abort();
    const error = await pending.catch((e) => e);
    expect(error.name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(AiTimeout);
  });

  it("rejects blocked and empty answers", async () => {
    const blocked = provider(
      vi.fn().mockResolvedValue(ok({ promptFeedback: { blockReason: "SAFETY" } })),
    );
    await expect(blocked.generateText("x")).rejects.toBeInstanceOf(AiInvalidOutput);
    const empty = provider(vi.fn().mockResolvedValue(ok({ candidates: [] })));
    await expect(empty.generateText("x")).rejects.toBeInstanceOf(AiInvalidOutput);
  });
});

describe("GeminiProvider.generateStructured", () => {
  it("requests JSON, includes the schema, and validates the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(reply('{"title":"Hi"}')));
    await expect(provider(fetchMock).generateStructured("p", schema)).resolves.toEqual({
      title: "Hi",
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.systemInstruction.parts[0].text).toContain('"title"');
  });

  it("repairs invalid JSON once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok(reply("oops")))
      .mockResolvedValueOnce(ok(reply('{"title":"Fixed"}')));
    await expect(provider(fetchMock).generateStructured("p", schema)).resolves.toEqual({
      title: "Fixed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails with ai_invalid_output when JSON is invalid twice", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ok(reply("not json"))));
    const error = await provider(fetchMock)
      .generateStructured("p", schema)
      .catch((e) => e);
    expect(error).toBeInstanceOf(AiInvalidOutput);
    expect(error).toMatchObject({ status: 502, code: "ai_invalid_output" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects output that parses but breaks the schema", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ok(reply('{"title":""}'))));
    await expect(provider(fetchMock).generateStructured("p", schema)).rejects.toBeInstanceOf(
      AiInvalidOutput,
    );
  });

  it("does not retry quota errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(failure(429));
    await expect(provider(fetchMock).generateStructured("p", schema)).rejects.toBeInstanceOf(
      AiQuotaExceeded,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("GeminiProvider.streamText", () => {
  function sse(chunks: string[]) {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      }),
      { status: 200 },
    );
  }

  it("yields text across chunk boundaries", async () => {
    const event = (t: string) => `data: ${JSON.stringify(reply(t))}\n\n`;
    const whole = event("Hel") + event("lo");
    const fetchMock = vi.fn().mockResolvedValue(sse([whole.slice(0, 20), whole.slice(20)]));
    const parts: string[] = [];
    for await (const t of provider(fetchMock).streamText("hi")) parts.push(t);
    expect(parts.join("")).toBe("Hello");
    expect(String(fetchMock.mock.calls[0]![0])).toContain(":streamGenerateContent?alt=sse");
  });

  it("maps a 429 before streaming starts", async () => {
    const p = provider(vi.fn().mockResolvedValue(failure(429)));
    await expect(p.streamText("hi").next()).rejects.toBeInstanceOf(AiQuotaExceeded);
  });
});

describe("createProvider", () => {
  it("is disabled by default and without a key", async () => {
    expect(createProvider({ AI_PROVIDER: "disabled" }).name).toBe("disabled");
    const noKey = createProvider({ AI_PROVIDER: "gemini" });
    expect(noKey.name).toBe("disabled");
    await expect(noKey.generateText("x")).rejects.toMatchObject({ code: "ai_unavailable" });
  });

  it("uses Gemini with a key and the configured or default model", () => {
    expect(createProvider({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" }).name).toBe("gemini");
    expect(DEFAULT_GEMINI_MODEL).not.toBe("gemini-2.0-flash");
  });
});

describe("GeminiProvider token usage", () => {
  const withUsage = (text: string, usage?: object) =>
    ok({ ...reply(text), ...(usage ? { usageMetadata: usage } : {}) });

  it("reports the tokens Gemini returned, summed over a repair request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        withUsage("nope", { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 }),
      )
      .mockResolvedValueOnce(
        withUsage('{"title":"x"}', { promptTokenCount: 14, candidatesTokenCount: 5 }),
      );
    const seen: object[] = [];
    await provider(fetchMock).generateStructured("q", schema, { onUsage: (u) => seen.push(u) });
    expect(seen).toEqual([
      { inputTokens: 10, outputTokens: 2 },
      { inputTokens: 14, outputTokens: 5 },
    ]);
  });

  it("reports nothing when the response has no usage metadata", async () => {
    const onUsage = vi.fn();
    await provider(vi.fn().mockResolvedValue(withUsage("hi"))).generateText("q", { onUsage });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("uses only the last streamed usage, since each chunk repeats the running totals", async () => {
    const sse = (u: object, text: string) =>
      `data: ${JSON.stringify({ ...reply(text), usageMetadata: u })}\n\n`;
    const body =
      sse({ promptTokenCount: 8, candidatesTokenCount: 1 }, "a") +
      sse({ promptTokenCount: 8, candidatesTokenCount: 4 }, "b");
    const onUsage = vi.fn();
    const chunks: string[] = [];
    for await (const c of provider(vi.fn().mockResolvedValue(new Response(body))).streamText("q", {
      onUsage,
    })) {
      chunks.push(c);
    }
    expect(chunks).toEqual(["a", "b"]);
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 8, outputTokens: 4 });
  });

  it("exposes the configured model id", () => {
    expect(provider(vi.fn()).model).toBe("gemini-test");
  });
});
