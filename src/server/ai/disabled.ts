import type { z } from "zod";
import { AiUnavailable } from "./errors";
import type { AiMessage, AiProvider, GenerateOptions } from "./provider";

/** Used when AI_PROVIDER=disabled or no credentials are configured. Practice never needs AI. */
export class DisabledProvider implements AiProvider {
  readonly name = "disabled";

  constructor(public readonly reason = "AI help is turned off on this server.") {}

  generateText(...args: [input: string | AiMessage[], options?: GenerateOptions]): Promise<string> {
    void args;
    return Promise.reject(new AiUnavailable(this.reason));
  }

  generateStructured<T>(
    ...args: [input: string | AiMessage[], schema: z.ZodType<T>, options?: GenerateOptions]
  ): Promise<T> {
    void args;
    return Promise.reject(new AiUnavailable(this.reason));
  }

  async *streamText(
    ...args: [input: string | AiMessage[], options?: GenerateOptions]
  ): AsyncGenerator<string> {
    void args;
    throw new AiUnavailable(this.reason);
  }
}
