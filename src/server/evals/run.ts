import { z } from "zod";
import { tutorOutputSchema, type HelpAction } from "@/lib/schemas";
import type { EvalCase, EvalCaseOf } from "@/lib/schemas/eval";
import { AiInvalidOutput, AiQuotaExceeded } from "@/server/ai/errors";
import { GENERATION_PROMPT_VERSION, proposeQuestions } from "@/server/ai/assistant";
import { DATA_NOT_INSTRUCTIONS, delimitData } from "@/server/ai/prompt";
import type { AiProvider } from "@/server/ai/provider";
import { VALIDATOR_VERSION } from "@/server/content-checks/checks";
import { gradeResponse } from "@/server/grading";
import {
  buildPrompt,
  shapeOutput,
  TUTOR_CALL_OPTIONS,
  TUTOR_PROMPT_VERSION,
  type PromptPassage,
} from "@/server/tutor/help";
import type { LoadedCase } from "./load";
import { aggregate, type Aggregate, type CaseResult } from "./metrics";
import type { RequestMeter } from "./mock";
import { localUuid, scoreGeneration, scoreGrading, scoreTutor, type GradingOutcome } from "./score";

export const PROMPT_VERSIONS = {
  tutor: TUTOR_PROMPT_VERSION,
  generation: GENERATION_PROMPT_VERSION,
  /** Evaluation only: there is no AI grader in the app. */
  grading: "grading-research-v1",
};
export { VALIDATOR_VERSION };

/**
 * Research only. The app grades short answers deterministically; this prompt exists so the
 * harness can measure how a model would compare, and nothing in the app uses it.
 */
const gradingOutputSchema = z.strictObject({
  outcome: z.enum(["correct", "incorrect", "uncertain"]),
  rationale: z.string().trim().min(1).max(500),
});

type RunContext = { provider: AiProvider; meter: RequestMeter };

const revisionOf = (q: EvalCaseOf<"hint">["input"]["question"]) =>
  ({
    type: q.type,
    prompt: q.prompt,
    codeSnippet: q.codeSnippet ?? null,
    options: q.options,
    answerKey: q.answerKey,
    explanation: q.explanation ?? null,
  }) as never;

async function runTutor(c: EvalCaseOf<"hint"> | EvalCaseOf<"explanation">, ctx: RunContext) {
  const { input } = c;
  const idByLocal = new Map(input.passages.map((p) => [localUuid(c.id, p.id), p.id]));
  const passages: PromptPassage[] = input.passages.map((p) => ({
    id: localUuid(c.id, p.id),
    filename: p.filename,
    location: p.location,
    text: p.text,
  }));
  const turn = {
    action: input.action as HelpAction,
    revision: revisionOf(input.question),
    priorWrong: input.priorWrong ?? null,
    protectedRetry: input.protectedRetry,
  };
  const { system, prompt } = buildPrompt(turn, passages, null);
  const output = await ctx.provider.generateStructured(prompt, tutorOutputSchema, {
    system,
    ...TUTOR_CALL_OPTIONS,
  });
  let shaped: ReturnType<typeof shapeOutput>;
  try {
    shaped = shapeOutput(turn, output, passages);
  } catch (error) {
    if (error instanceof AiInvalidOutput) {
      return { ...scoreTutor(c, null), withheld: true, output };
    }
    throw error;
  }
  const local = (id: string) => idByLocal.get(id) ?? id;
  const judged = scoreTutor(c, {
    text: shaped.text,
    sourceSupported: shaped.sourceSupported,
    uncertainty: shaped.uncertainty,
    citedLocalIds: shaped.cited.map((p) => local(p.id)),
    fabricatedIds: shaped.fabricatedIds,
  });
  return { ...judged, withheld: false, output };
}

async function runGeneration(c: EvalCaseOf<"question_generation">, ctx: RunContext) {
  try {
    const result = await proposeQuestions(
      ctx.provider,
      { course: c.input.course, prompts: c.input.existingPrompts },
      { count: c.input.count, topic: c.input.topic } as never,
    );
    return { ...scoreGeneration(c, result as never), withheld: false, output: result.proposals };
  } catch (error) {
    if (error instanceof AiInvalidOutput) {
      return { ...scoreGeneration(c, null), withheld: true, output: undefined };
    }
    throw error;
  }
}

async function runGrading(c: EvalCaseOf<"short_answer_grading">, ctx: RunContext) {
  const q = c.input.question;
  const prompt = [
    delimitData("question", JSON.stringify({ type: q.type, prompt: q.prompt })),
    delimitData("accepted answers", JSON.stringify(q.answerKey)),
    delimitData("student answer", JSON.stringify(c.input.response)),
  ].join("\n\n");
  const output = await ctx.provider.generateStructured(prompt, gradingOutputSchema, {
    system:
      "You mark a student's short answer against the accepted answers. Say correct only if the " +
      "student's answer means the same as an accepted answer, incorrect if it does not, and " +
      `uncertain if you cannot tell. ${DATA_NOT_INSTRUCTIONS}`,
    maxOutputTokens: 400,
    temperature: 0,
  });
  return { ...scoreGrading(c, output.outcome), withheld: false, output };
}

/** The app's own grading on the same cases: the baseline any model is compared with. */
export function gradeBaseline(cases: LoadedCase[]): CaseResult[] {
  return cases.flatMap(({ case: c }) => {
    if (c.task !== "short_answer_grading") return [];
    const outcome = gradeResponse(
      { type: c.input.question.type, answerKey: c.input.question.answerKey } as never,
      c.input.response,
    ) as GradingOutcome;
    const judged = scoreGrading(c, outcome);
    return [
      {
        id: c.id,
        task: c.task,
        language: c.language,
        tags: c.tags,
        status: "completed" as const,
        judgments: judged.judgments,
        requests: 0,
        notes: judged.notes,
      },
    ];
  });
}

export type RunOptions = {
  cases: LoadedCase[];
  makeProvider: (c: EvalCase) => { provider: AiProvider; meter: RequestMeter };
  /** Minimum time between model calls, to respect rate limits. */
  minIntervalMs?: number;
  /** Stop before making more than this many requests in total. */
  maxRequests?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onResult?: (result: CaseResult) => void;
};

export type RunOutcome = {
  results: CaseResult[];
  aggregate: Aggregate;
  /** Set when the run stopped early (quota, or the request cap). The rest is unvalidated. */
  stoppedBecause?: "quota" | "request_cap";
};

const normalizeError = (error: unknown) =>
  error instanceof AiQuotaExceeded
    ? "ai_quota_exceeded"
    : error instanceof Error &&
        "code" in error &&
        typeof (error as { code: unknown }).code === "string"
      ? (error as { code: string }).code
      : "error";

/**
 * Runs every case through the app's own prompts and checks. One case failing never stops the
 * others, except quota: a provider out of quota stops the run and leaves the rest unvalidated,
 * and nothing switches to another model.
 */
export async function runEval(options: RunOptions): Promise<RunOutcome> {
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const results: CaseResult[] = [];
  let requests = 0;
  let stoppedBecause: RunOutcome["stoppedBecause"];

  const record = (result: CaseResult) => {
    results.push(result);
    options.onResult?.(result);
  };
  const unvalidated = (c: EvalCase, errorCode: string): CaseResult => ({
    id: c.id,
    task: c.task,
    language: c.language,
    tags: c.tags,
    status: "unvalidated",
    errorCode,
    judgments: {},
    requests: 0,
    notes: [],
  });

  let first = true;
  for (const { case: c } of options.cases) {
    if (stoppedBecause) {
      record(unvalidated(c, stoppedBecause === "quota" ? "ai_quota_exceeded" : "not_run"));
      continue;
    }
    if (options.maxRequests !== undefined && requests >= options.maxRequests) {
      stoppedBecause = "request_cap";
      record(unvalidated(c, "not_run"));
      continue;
    }
    if (!first && options.minIntervalMs) await sleep(options.minIntervalMs);
    first = false;

    const { provider, meter } = options.makeProvider(c);
    const before = meter.requests;
    const started = now();
    try {
      const ctx = { provider, meter };
      const done =
        c.task === "hint" || c.task === "explanation"
          ? await runTutor(c, ctx)
          : c.task === "question_generation"
            ? await runGeneration(c, ctx)
            : await runGrading(c, ctx);
      const used = meter.requests - before;
      requests += used;
      record({
        id: c.id,
        task: c.task,
        language: c.language,
        tags: c.tags,
        status: "completed",
        withheld: done.withheld,
        judgments: done.judgments,
        latencyMs: now() - started,
        requests: used,
        notes: done.notes,
        output: done.output,
      });
    } catch (error) {
      const used = meter.requests - before;
      requests += used;
      const code = normalizeError(error);
      if (error instanceof AiQuotaExceeded) stoppedBecause = "quota";
      record({
        ...unvalidated(c, code),
        status: code === "ai_quota_exceeded" ? "unvalidated" : "error",
        requests: used,
      });
    }
  }
  return { results, aggregate: aggregate(results), stoppedBecause };
}
