import type { z } from "zod";

export type AiMessage = { role: "user" | "assistant"; content: string };

export type GenerateOptions = {
  /** System instruction. Trusted text only; stored content goes in the prompt as delimited data. */
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Hard deadline for the whole call, including any repair retry. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

export interface AiProvider {
  readonly name: string;
  generateText(input: string | AiMessage[], options?: GenerateOptions): Promise<string>;
  /**
   * Asks for JSON, parses it, and validates it with `schema`. One bounded repair retry,
   * then AiInvalidOutput. The model's output is a proposal, never trusted as-is.
   */
  generateStructured<T>(
    input: string | AiMessage[],
    schema: z.ZodType<T>,
    options?: GenerateOptions,
  ): Promise<T>;
  streamText(input: string | AiMessage[], options?: GenerateOptions): AsyncIterable<string>;
}

export function toMessages(input: string | AiMessage[]): AiMessage[] {
  return typeof input === "string" ? [{ role: "user", content: input }] : input;
}
