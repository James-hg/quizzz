import "server-only";
import { getEnv } from "@/server/env";
import { DisabledProvider } from "./disabled";
import { GeminiProvider } from "./gemini";
import type { AiProvider } from "./provider";

/**
 * Used when GEMINI_MODEL is not set. A starting point only: the final choice comes from the
 * evaluation harness (see docs/ai-model.md).
 */
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

const globalForAi = globalThis as unknown as { __quizzzAi?: AiProvider };

export function createProvider(env: {
  AI_PROVIDER: "gemini" | "disabled";
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}): AiProvider {
  if (env.AI_PROVIDER === "gemini") {
    if (!env.GEMINI_API_KEY) {
      return new DisabledProvider("AI help is not configured on this server.");
    }
    return new GeminiProvider({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
    });
  }
  return new DisabledProvider();
}

export function getAiProvider(): AiProvider {
  globalForAi.__quizzzAi ??= createProvider(getEnv());
  return globalForAi.__quizzzAi;
}

/** Test seam: replace (or reset with undefined) the process-wide provider. */
export function setAiProviderForTesting(provider: AiProvider | undefined): void {
  globalForAi.__quizzzAi = provider;
}

export { AiInvalidOutput, AiQuotaExceeded, AiTimeout, AiUnavailable } from "./errors";
export type { AiMessage, AiProvider, GenerateOptions } from "./provider";
