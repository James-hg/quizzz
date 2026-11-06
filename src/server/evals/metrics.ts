import type { EvalTask } from "@/lib/schemas/eval";

/**
 * Metrics stay separate: there is no single score. Each has its own denominator, which counts
 * only the cases where the metric applies. A judgment a script cannot make is
 * `needs_human_review` and stays out of the rate; it is never counted as a pass.
 */

export const METRICS = [
  "answer_correctness",
  "citation_validity",
  "hint_leakage",
  "step_correctness",
  "ambiguity_handling",
  "rubric_agreement",
  "generation_yield",
  "false_accept",
] as const;
export type MetricName = (typeof METRICS)[number];

export type Judgment = "pass" | "fail" | "needs_human_review" | "not_scored";

export type CaseResult = {
  id: string;
  task: EvalTask;
  language: string;
  tags: string[];
  status: "completed" | "unvalidated" | "error";
  /** Why a case is unvalidated or errored: a normalized code, never provider text. */
  errorCode?: string;
  /** The production checks refused the model's answer, so a student would have seen none. */
  withheld?: boolean;
  judgments: Partial<Record<MetricName, Judgment>>;
  latencyMs?: number;
  requests: number;
  /** Specific facts for the person reviewing, for example the text a hint leaked. */
  notes: string[];
  /** The model's answer, for human review. Kept out of the printed summary. */
  output?: unknown;
};

export type Tally = {
  pass: number;
  fail: number;
  needsHumanReview: number;
  notScored: number;
  /** pass + fail: the cases the script could judge. */
  denominator: number;
  /** pass / denominator, or null when nothing could be judged. */
  rate: number | null;
};

export function tallyOf(judgments: Judgment[]): Tally {
  const pass = judgments.filter((j) => j === "pass").length;
  const fail = judgments.filter((j) => j === "fail").length;
  const denominator = pass + fail;
  return {
    pass,
    fail,
    needsHumanReview: judgments.filter((j) => j === "needs_human_review").length,
    notScored: judgments.filter((j) => j === "not_scored").length,
    denominator,
    rate: denominator === 0 ? null : pass / denominator,
  };
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

export type Aggregate = {
  total: number;
  completed: number;
  /** Not run (quota, timeout, error) or refused: never counted as passes. */
  unvalidated: number;
  withheld: number;
  metrics: Partial<Record<MetricName, Tally>>;
  latencyMs: { count: number; p50: number | null; p95: number | null; max: number | null };
  requestCount: number;
  /** Cases with a given tag, so a reader sees what the set covers. */
  tagCounts: Record<string, number>;
};

export function aggregate(results: readonly CaseResult[]): Aggregate {
  const metrics: Aggregate["metrics"] = {};
  for (const name of METRICS) {
    const judgments = results
      .filter((r) => r.status === "completed")
      .flatMap((r) => (r.judgments[name] ? [r.judgments[name]!] : []));
    if (judgments.length > 0) metrics[name] = tallyOf(judgments);
  }
  const latencies = results.flatMap((r) =>
    r.status === "completed" && r.latencyMs !== undefined ? [r.latencyMs] : [],
  );
  const tagCounts: Record<string, number> = {};
  for (const r of results) for (const tag of r.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
  return {
    total: results.length,
    completed: results.filter((r) => r.status === "completed").length,
    unvalidated: results.filter((r) => r.status !== "completed").length,
    withheld: results.filter((r) => r.withheld).length,
    metrics,
    latencyMs: {
      count: latencies.length,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    requestCount: results.reduce((n, r) => n + r.requests, 0),
    tagCounts,
  };
}
