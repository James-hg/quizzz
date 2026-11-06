import type { z } from "zod";
import { HELP_ACTION_LEVEL } from "@/lib/schemas";
import type { EvalCase } from "@/lib/schemas/eval";
import type { AiProvider } from "@/server/ai/provider";
import { localUuid } from "./score";

/**
 * A provider that answers from canned text, for testing the harness itself. Its results say
 * nothing about any model: every report made with it is labelled smoke evidence. It exists only
 * in the evaluation code and tests, never in a path the app serves.
 */

export type RequestMeter = {
  requests: number;
  inputTokens?: number;
  outputTokens?: number;
};

function canned(c: EvalCase): unknown {
  switch (c.task) {
    case "hint":
    case "explanation": {
      const { action } = c.input;
      const accepted = c.expected.acceptedAnswerStrings[0];
      const allowed = c.allowedCitationIds.map((id) => localUuid(c.id, id));
      return {
        level: HELP_ACTION_LEVEL[action as keyof typeof HELP_ACTION_LEVEL],
        text:
          c.task === "explanation" && accepted
            ? `Work it through step by step. The result is ${accepted}.`
            : "Think about the idea this question is testing and what the passage says about it.",
        citedSegmentIds: allowed.slice(0, 1),
        sourceSupported: allowed.length > 0,
        ...(c.expected.abstain || allowed.length === 0
          ? { uncertainty: "I am not certain the notes cover this." }
          : {}),
      };
    }
    case "question_generation":
      return {
        questions: Array.from({ length: c.input.count }, (_, i) => ({
          prompt: `Smoke question ${i + 1} about ${c.input.course.subject}?`,
          options: ["First", "Second", "Third", "Fourth"],
          correctIndex: 0,
          explanation: "The answer is A.",
        })),
      };
    case "short_answer_grading":
      return { outcome: c.expected.outcome, rationale: "canned" };
  }
}

export function createMockProvider(c: EvalCase, meter: RequestMeter): AiProvider {
  return {
    name: "mock",
    async generateStructured<T>(_input: unknown, schema: z.ZodType<T>) {
      meter.requests += 1;
      return schema.parse(canned(c));
    },
    async generateText() {
      throw new Error("the mock provider only answers structured calls");
    },
    async *streamText() {
      throw new Error("the mock provider only answers structured calls");
    },
  };
}
