import { EVAL_TASKS, type EvalTask } from "@/lib/schemas/eval";
import { GeminiProvider } from "@/server/ai/gemini";
import type { AiProvider } from "@/server/ai/provider";
import { coverage, loadEvalDir } from "./load";
import { aggregate } from "./metrics";
import { createMockProvider, type RequestMeter } from "./mock";
import { gradeBaseline, PROMPT_VERSIONS, runEval, VALIDATOR_VERSION } from "./run";

export type CliDeps = {
  env: Record<string, string | undefined>;
  appCommit: () => string;
  writeFile: (file: string, text: string) => void;
  log: (line: string) => void;
  error: (line: string) => void;
  tasks?: readonly EvalTask[];
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: replaces fetch for live runs. */
  fetch?: typeof fetch;
  now?: () => Date;
};

const MAX_LIVE_CASES = 200;
const DEFAULT_RPM = 10;

type Parsed = {
  task?: EvalTask;
  language?: string;
  provider: "mock" | "gemini";
  model?: string;
  dir: string;
  maxCases?: number;
  maxRequests?: number;
  rpm: number;
  live: boolean;
  out?: string;
};

function parseArgs(args: string[]): Parsed | string {
  const out: Parsed = { provider: "mock", dir: "evals", rpm: DEFAULT_RPM, live: false };
  const value = (i: number, name: string) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  const whole = (raw: string, name: string) => {
    if (!/^\d+$/.test(raw) || Number(raw) < 1)
      throw new Error(`${name} must be a whole number of 1 or more`);
    return Number(raw);
  };
  try {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      switch (a) {
        case "--task": {
          const t = value(i++, a);
          if (!(EVAL_TASKS as readonly string[]).includes(t))
            throw new Error(`unknown task "${t}"`);
          out.task = t as EvalTask;
          break;
        }
        case "--language":
          out.language = value(i++, a);
          break;
        case "--provider": {
          const p = value(i++, a);
          if (p !== "mock" && p !== "gemini")
            throw new Error('--provider must be "mock" or "gemini"');
          out.provider = p;
          break;
        }
        case "--model":
          out.model = value(i++, a);
          break;
        case "--dir":
          out.dir = value(i++, a);
          break;
        case "--max-cases":
          out.maxCases = whole(value(i++, a), a);
          break;
        case "--max-requests":
          out.maxRequests = whole(value(i++, a), a);
          break;
        case "--rpm":
          out.rpm = whole(value(i++, a), a);
          break;
        case "--live":
          out.live = true;
          break;
        case "--out":
          out.out = value(i++, a);
          break;
        default:
          throw new Error(`unknown option ${a}`);
      }
    }
  } catch (error) {
    return (error as Error).message;
  }
  return out;
}

/** Wraps fetch to count requests and read the token counts Gemini reports, when it reports them. */
export function meteredFetch(base: typeof fetch, meter: RequestMeter): typeof fetch {
  return async (input, init) => {
    meter.requests += 1;
    const response = await base(input, init);
    try {
      const body = (await response.clone().json()) as {
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const usage = body.usageMetadata;
      if (usage) {
        meter.inputTokens = (meter.inputTokens ?? 0) + (usage.promptTokenCount ?? 0);
        meter.outputTokens = (meter.outputTokens ?? 0) + (usage.candidatesTokenCount ?? 0);
      }
    } catch {
      // Not JSON (an error page): nothing to read.
    }
    return response;
  };
}

/**
 * Returns the process exit code: 0 done, 1 bad input or a fault in the harness, 2 a live run
 * that stopped early (quota or request cap) with the rest left unvalidated.
 */
export async function runCli(args: string[], deps: CliDeps): Promise<number> {
  const parsed = parseArgs(args);
  if (typeof parsed === "string") {
    deps.error(`${parsed}. See evals/README.md.`);
    return 1;
  }
  const o = parsed;

  const loaded = loadEvalDir(o.dir, { task: o.task, language: o.language });
  if (loaded.problems.length > 0) {
    for (const p of loaded.problems)
      deps.error(`${p.file}${p.line ? `:${p.line}` : ""}  ${p.message}`);
    deps.error(`${loaded.problems.length} problem(s) in the evaluation files. Nothing was run.`);
    return 1;
  }
  let cases = loaded.cases;
  const live = o.provider === "gemini";

  if (live) {
    const missing = [
      !o.live && "--live",
      !o.model && "--model <id>",
      o.maxCases === undefined && "--max-cases <n>",
      !deps.env.GEMINI_API_KEY && "GEMINI_API_KEY in the environment",
    ].filter(Boolean);
    if (missing.length > 0) {
      deps.error(`A live Gemini run needs: ${missing.join(", ")}. No request was made.`);
      return 1;
    }
    if (o.maxCases! > MAX_LIVE_CASES) {
      deps.error(`--max-cases is limited to ${MAX_LIVE_CASES} per run.`);
      return 1;
    }
    if (cases.some((c) => c.case.kind === "smoke")) {
      deps.error("Smoke fixtures only test the harness and are never sent to a live model.");
      return 1;
    }
  } else if (o.live) {
    deps.error("--live only applies to --provider gemini.");
    return 1;
  }

  if (o.maxCases !== undefined) cases = cases.slice(0, o.maxCases);

  if (cases.length === 0) {
    deps.log(
      JSON.stringify(
        {
          task: o.task ?? "all",
          language: o.language ?? "all",
          total: 0,
          unvalidated: "no checked cases for this selection",
          note: "Nothing was scored. Without checked cases no model can be chosen for this task.",
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const meter: RequestMeter = { requests: 0 };
  let makeProvider: (c: (typeof cases)[number]["case"]) => {
    provider: AiProvider;
    meter: RequestMeter;
  };
  let maxRequests: number | undefined;
  let minIntervalMs: number | undefined;
  if (live) {
    const provider = new GeminiProvider({
      apiKey: deps.env.GEMINI_API_KEY!,
      model: o.model!,
      fetch: meteredFetch(deps.fetch ?? fetch, meter),
    });
    makeProvider = () => ({ provider, meter });
    maxRequests = o.maxRequests ?? cases.length * 2;
    minIntervalMs = Math.ceil(60_000 / o.rpm);
    // Said before the first call. A structured call may make one more request to repair a reply.
    deps.error(
      `Live run: ${cases.length} case(s) with ${o.model}. Expect ${cases.length} to ${cases.length * 2} requests ` +
        `(a repair retry adds one); stopping after ${maxRequests}. One call every ${Math.round(minIntervalMs / 1000)}s. ` +
        "A quota error stops the run and leaves the rest unvalidated.",
    );
  } else {
    makeProvider = (c) => {
      const perCase: RequestMeter = { requests: 0 };
      return { provider: createMockProvider(c, perCase), meter: perCase };
    };
  }

  const outcome = await runEval({
    cases,
    makeProvider,
    maxRequests,
    minIntervalMs,
    sleep: deps.sleep,
  });

  const tasks = [...new Set(cases.map((c) => c.case.task))];
  const baselineCases = cases.filter((c) => c.case.task === "short_answer_grading");
  const summary = {
    date: (deps.now?.() ?? new Date()).toISOString().slice(0, 10),
    task: o.task ?? tasks.join(","),
    language: o.language ?? [...new Set(cases.map((c) => c.case.language))].join(","),
    provider: o.provider,
    model: live ? o.model : "mock",
    // Mock output proves the plumbing works. It says nothing about any model.
    evidence: live ? "live" : "smoke",
    researchOnly: tasks.includes("short_answer_grading")
      ? "short_answer_grading: the app grades deterministically; a model grader is measured for comparison only"
      : undefined,
    fixtureHash: loaded.fixtureHash,
    appCommit: deps.appCommit(),
    promptVersions: PROMPT_VERSIONS,
    validatorVersion: VALIDATOR_VERSION,
    ...outcome.aggregate,
    tokenUsage:
      meter.inputTokens !== undefined
        ? { input: meter.inputTokens, output: meter.outputTokens ?? 0 }
        : live
          ? "unavailable"
          : undefined,
    stoppedBecause: outcome.stoppedBecause,
    errors: Object.fromEntries(
      outcome.results
        .filter((r) => r.errorCode)
        .reduce(
          (m, r) => m.set(r.errorCode!, (m.get(r.errorCode!) ?? 0) + 1),
          new Map<string, number>(),
        ),
    ),
    coverage: coverage(cases),
    baseline:
      baselineCases.length > 0
        ? { name: "deterministic grading (the app)", ...aggregate(gradeBaseline(baselineCases)) }
        : undefined,
    needsHumanReview:
      "Semantic correctness, step validity and source support are not scored by this script.",
  };
  deps.log(JSON.stringify(summary, null, 2));

  if (o.out) {
    deps.writeFile(o.out, JSON.stringify({ summary, results: outcome.results }, null, 2));
    deps.error(`Per-case results (including model answers) written to ${o.out}.`);
  }
  return outcome.stoppedBecause ? 2 : 0;
}
