import "server-only";
import type { z } from "zod";
import { AiInvalidOutput, AiQuotaExceeded, AiTimeout, AiUnavailable } from "./errors";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
  toMessages,
  type AiMessage,
  type AiProvider,
  type GenerateOptions,
} from "./provider";
import { schemaInstruction, structuredWithRepair } from "./structured";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export type GeminiConfig = {
  apiKey: string;
  model: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  baseUrl?: string;
};

type Part = { text?: string };
type GeminiResponse = {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
};

/** Maps an HTTP failure to a normalized error. Never includes the key or the response body. */
export function mapHttpError(status: number, apiStatus?: string): Error {
  console.error(`Gemini request failed: HTTP ${status}${apiStatus ? ` ${apiStatus}` : ""}`);
  if (status === 429) return new AiQuotaExceeded();
  if (status === 408 || status === 504) return new AiTimeout();
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return new AiUnavailable("AI help is not configured correctly on this server.");
  }
  return new AiUnavailable("The AI service is temporarily unavailable.");
}

async function apiStatusOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { status?: string } };
    return body.error?.status;
  } catch {
    return undefined;
  }
}

function textOf(body: GeminiResponse): string {
  if (body.promptFeedback?.blockReason) {
    throw new AiInvalidOutput("The AI service declined to answer that.");
  }
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("");
  if (text.trim() === "") throw new AiInvalidOutput("The AI service returned an empty answer.");
  return text;
}

/** One deadline for a whole call; aborts when the deadline passes or the caller's signal fires. */
function withDeadline(options: GenerateOptions | undefined) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (options?.signal?.aborted) controller.abort();
  else options?.signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
    },
  };
}

export class GeminiProvider implements AiProvider {
  readonly name = "gemini";
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly config: GeminiConfig) {
    this.fetchImpl = config.fetch ?? fetch;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  private request(
    method: "generateContent" | "streamGenerateContent",
    messages: AiMessage[],
    options: GenerateOptions | undefined,
    json: boolean,
    signal: AbortSignal,
  ) {
    const body = {
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      ...(options?.system ? { systemInstruction: { parts: [{ text: options.system }] } } : {}),
      generationConfig: {
        maxOutputTokens: options?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(json ? { responseMimeType: "application/json" } : {}),
      },
    };
    const query = method === "streamGenerateContent" ? "?alt=sse" : "";
    return this.fetchImpl(`${this.baseUrl}/models/${this.config.model}:${method}${query}`, {
      method: "POST",
      // The key travels in a header, never in the URL, so it cannot end up in logs.
      headers: { "content-type": "application/json", "x-goog-api-key": this.config.apiKey },
      body: JSON.stringify(body),
      signal,
    });
  }

  private async call(
    messages: AiMessage[],
    options: GenerateOptions | undefined,
    json: boolean,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await this.request("generateContent", messages, options, json, signal);
    if (!response.ok) throw mapHttpError(response.status, await apiStatusOf(response));
    return textOf((await response.json()) as GeminiResponse);
  }

  /** Converts low-level failures (abort, network) into normalized errors. */
  private normalize(error: unknown, deadline: ReturnType<typeof withDeadline>): never {
    if (error instanceof Error && error.name === "AbortError") {
      if (deadline.timedOut()) throw new AiTimeout();
      throw error; // cancelled by the caller
    }
    if (error instanceof TypeError) {
      console.error("Gemini request failed: network error");
      throw new AiUnavailable("The AI service could not be reached.");
    }
    throw error;
  }

  async generateText(input: string | AiMessage[], options?: GenerateOptions): Promise<string> {
    const deadline = withDeadline(options);
    try {
      return await this.call(toMessages(input), options, false, deadline.signal);
    } catch (error) {
      return this.normalize(error, deadline);
    } finally {
      deadline.done();
    }
  }

  async generateStructured<T>(
    input: string | AiMessage[],
    schema: z.ZodType<T>,
    options?: GenerateOptions,
  ): Promise<T> {
    const deadline = withDeadline(options);
    const system = [options?.system, schemaInstruction(schema)].filter(Boolean).join("\n\n");
    try {
      return await structuredWithRepair(
        (messages) => this.call(messages, { ...options, system }, true, deadline.signal),
        input,
        schema,
      );
    } catch (error) {
      return this.normalize(error, deadline);
    } finally {
      deadline.done();
    }
  }

  async *streamText(
    input: string | AiMessage[],
    options?: GenerateOptions,
  ): AsyncGenerator<string> {
    const deadline = withDeadline(options);
    try {
      const response = await this.request(
        "streamGenerateContent",
        toMessages(input),
        options,
        false,
        deadline.signal,
      );
      if (!response.ok) throw mapHttpError(response.status, await apiStatusOf(response));
      if (!response.body) throw new AiUnavailable("The AI service returned no data.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of event.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let chunk: GeminiResponse;
            try {
              chunk = JSON.parse(payload) as GeminiResponse;
            } catch {
              throw new AiInvalidOutput();
            }
            const text = (chunk.candidates?.[0]?.content?.parts ?? [])
              .map((p) => p.text ?? "")
              .join("");
            if (text) yield text;
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      this.normalize(error, deadline);
    } finally {
      deadline.done();
    }
  }
}
