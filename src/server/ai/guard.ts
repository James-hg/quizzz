import "server-only";
import type { SessionUser } from "@/server/auth/session";
import { requireUser } from "@/server/auth/session";
import type { Database } from "@/server/db";
import { aiCallLogs } from "@/server/db/schema";
import { getEnv } from "@/server/env";
import { DisabledProvider } from "./disabled";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import {
  AiInputTooLarge,
  AiInvalidOutput,
  AiQuotaExceeded,
  AiTimeout,
  AiUnavailable,
} from "./errors";
import { getAiProvider } from "./index";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  toMessages,
  type AiMessage,
  type AiProvider,
  type GenerateOptions,
} from "./provider";
import {
  admitAiOperation,
  OPERATION_DEADLINE_MS,
  recordProviderSuccess,
  recordQuotaError,
  releaseAiOperation,
  type Admission,
} from "./usage";

/**
 * First step of every AI route: sign-in required (401), then a clear 503 when AI is off, so
 * nothing else (validation, quota, database work) happens for an unavailable feature.
 */
export async function requireAi(
  request: Request,
): Promise<{ user: SessionUser; provider: AiProvider }> {
  const user = await requireUser(request);
  const provider = getAiProvider();
  if (provider instanceof DisabledProvider) throw new AiUnavailable(provider.reason);
  return { user, provider };
}

export type AiRoute = "chat" | "generate_questions" | "suggest_title" | "rewrite" | "help";
type Method = "generateText" | "generateStructured" | "streamText";
type Outcome = "success" | "quota" | "timeout" | "invalid_output" | "unavailable" | "cancelled";

function outcomeOf(error: unknown): Outcome {
  if (error instanceof AiQuotaExceeded) return "quota";
  if (error instanceof AiTimeout) return "timeout";
  if (error instanceof AiInvalidOutput) return "invalid_output";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "unavailable";
}

function inputChars(input: string | AiMessage[], options?: GenerateOptions): number {
  return (
    toMessages(input).reduce((sum, m) => sum + m.content.length, 0) + (options?.system?.length ?? 0)
  );
}

/**
 * Runs one AI operation (one request to a model route) with every limit applied. Call it after
 * validation and ownership checks. `run` gets a provider that:
 *  - refuses input over AI_MAX_INPUT_CHARS and caps the output tokens, before any quota is used;
 *  - on its first real call, counts the operation against the minute/hour/day and global caps,
 *    checks the concurrency limit and the paused state, and takes a lease;
 *  - writes one `ai_call_logs` row per provider invocation (latency, outcome, reported tokens);
 *  - feeds provider quota errors into the shared pause state.
 * The lease is always released when `run` ends. An operation that never reaches the provider
 * (say, an oversized request) uses no quota.
 */
export async function withAiOperation<T>(
  db: Database,
  input: { userId: string; route: AiRoute },
  provider: AiProvider,
  run: (metered: AiProvider) => Promise<T>,
): Promise<T> {
  const env = getEnv();
  const limits = {
    perMinute: env.AI_REQUESTS_PER_MINUTE,
    perHour: env.AI_REQUESTS_PER_HOUR,
    perDay: env.AI_REQUESTS_PER_DAY,
    globalPerDay: env.AI_GLOBAL_REQUESTS_PER_DAY,
    maxConcurrent: env.AI_MAX_CONCURRENT_CALLS,
  };
  // One deadline for the whole operation, so a retry cannot outlive the lease.
  const operation = new AbortController();
  const timer = setTimeout(() => operation.abort(), OPERATION_DEADLINE_MS);
  let admission: Promise<Admission> | undefined;
  const admit = () =>
    (admission ??= admitAiOperation(db, { userId: input.userId, route: input.route, limits }));

  const invoke = async <R>(
    method: Method,
    prompt: string | AiMessage[],
    options: GenerateOptions | undefined,
    call: (options: GenerateOptions) => Promise<R>,
  ): Promise<R> => {
    if (inputChars(prompt, options) > env.AI_MAX_INPUT_CHARS) throw new AiInputTooLarge();
    const current = await admit();
    const [log] = await db
      .insert(aiCallLogs)
      .values({ userId: input.userId, route: input.route, model: provider.model ?? null, method })
      .returning({ id: aiCallLogs.id });

    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const started = Date.now();
    let outcome: Outcome = "success";
    try {
      return await call({
        ...options,
        maxOutputTokens: Math.min(
          options?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          env.AI_MAX_OUTPUT_TOKENS,
        ),
        signal: options?.signal
          ? AbortSignal.any([options.signal, operation.signal])
          : operation.signal,
        onUsage: (usage) => {
          if (usage.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + usage.inputTokens;
          if (usage.outputTokens !== undefined) {
            outputTokens = (outputTokens ?? 0) + usage.outputTokens;
          }
          options?.onUsage?.(usage);
        },
      });
    } catch (error) {
      outcome = outcomeOf(error);
      throw error;
    } finally {
      await finish(current, log!.id, outcome, started, inputTokens, outputTokens);
    }
  };

  const finish = async (
    current: Admission,
    logId: string,
    outcome: Outcome,
    started: number,
    inputTokens: number | undefined,
    outputTokens: number | undefined,
  ) => {
    await db
      .update(aiCallLogs)
      .set({
        outcome,
        latencyMs: Date.now() - started,
        inputTokens: inputTokens ?? null,
        outputTokens: outputTokens ?? null,
        finishedAt: new Date(),
      })
      .where(eq(aiCallLogs.id, logId));
    if (outcome === "quota") await recordQuotaError(db, current);
    else if (outcome === "success") await recordProviderSuccess(db);
  };

  const metered: AiProvider = {
    name: provider.name,
    ...(provider.model ? { model: provider.model } : {}),
    generateText: (prompt, options) =>
      invoke("generateText", prompt, options, (o) => provider.generateText(prompt, o)),
    generateStructured: <R>(
      prompt: string | AiMessage[],
      schema: z.ZodType<R>,
      options?: GenerateOptions,
    ) =>
      invoke("generateStructured", prompt, options, (o) =>
        provider.generateStructured(prompt, schema, o),
      ),
    async *streamText(prompt, options) {
      if (inputChars(prompt, options) > env.AI_MAX_INPUT_CHARS) throw new AiInputTooLarge();
      const current = await admit();
      const [log] = await db
        .insert(aiCallLogs)
        .values({
          userId: input.userId,
          route: input.route,
          model: provider.model ?? null,
          method: "streamText",
        })
        .returning({ id: aiCallLogs.id });
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      const started = Date.now();
      // Stays "cancelled" if the consumer stops reading before the stream ends.
      let outcome: Outcome = "cancelled";
      try {
        yield* provider.streamText(prompt, {
          ...options,
          maxOutputTokens: Math.min(
            options?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            env.AI_MAX_OUTPUT_TOKENS,
          ),
          signal: options?.signal
            ? AbortSignal.any([options.signal, operation.signal])
            : operation.signal,
          onUsage: (usage) => {
            inputTokens = usage.inputTokens ?? inputTokens;
            outputTokens = usage.outputTokens ?? outputTokens;
            options?.onUsage?.(usage);
          },
        });
        outcome = "success";
      } catch (error) {
        outcome = outcomeOf(error);
        throw error;
      } finally {
        await finish(current, log!.id, outcome, started, inputTokens, outputTokens);
      }
    },
  };

  try {
    return await run(metered);
  } finally {
    clearTimeout(timer);
    if (admission) {
      // If admission itself was refused there is no lease to free.
      const granted = await admission.catch(() => undefined);
      if (granted) await releaseAiOperation(db, granted);
    }
  }
}
