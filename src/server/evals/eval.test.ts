import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { evalCaseSchema } from "@/lib/schemas/eval";
import { AiQuotaExceeded } from "@/server/ai/errors";
import type { AiProvider } from "@/server/ai/provider";
import { runCli, meteredFetch } from "./cli";
import { coverage, loadEvalDir, parseJsonl } from "./load";
import { aggregate, percentile, tallyOf, type CaseResult } from "./metrics";
import { createMockProvider, type RequestMeter } from "./mock";
import { gradeBaseline, runEval } from "./run";
import { localUuid, scoreGeneration, scoreGrading, scoreTutor, type ShapedTutor } from "./score";

const SMOKE = "src/test/fixtures/eval-smoke";

const review = {
  checkedBy: "A. Owner",
  checkedAt: "2026-11-01",
  rationale: "Checked against the course notes.",
};
const mcq = {
  type: "mcq_single",
  prompt: "What does len([1, 2, 3]) return?",
  options: [
    { id: "a", text: "2" },
    { id: "b", text: "3" },
  ],
  answerKey: { kind: "options", correctOptionIds: ["b"] },
};
const passage = {
  id: "s1",
  filename: "lists.md",
  location: "paragraph 2",
  text: "len counts items.",
};
const hintCase = (over: Record<string, unknown> = {}) => ({
  id: "hint-1",
  task: "hint",
  language: "python",
  allowedCitationIds: ["s1"],
  tags: [],
  review,
  sourceVersion: "v1",
  input: { question: mcq, action: "small_hint", passages: [passage] },
  expected: {
    forbiddenAnswerStrings: ["3"],
    requiredCitationIds: ["s1"],
    rubric: ["Points at counting."],
  },
  ...over,
});
const parse = (c: unknown) => evalCaseSchema.safeParse(c);

describe("case schema", () => {
  it("accepts a checked hint case", () => {
    expect(parse(hintCase()).success).toBe(true);
  });

  it.each([
    ["no review metadata", { review: undefined }],
    ["an empty reviewer", { review: { ...review, checkedBy: "" } }],
    ["a vague date", { review: { ...review, checkedAt: "yesterday" } }],
    ["a one-word rationale", { review: { ...review, rationale: "ok" } }],
    ["an unknown tag", { tags: ["weird"] }],
    ["an unknown task", { task: "poetry" }],
    ["an allowed citation that is not a passage", { allowedCitationIds: ["nope"] }],
    [
      "a required citation that is not allowed",
      {
        allowedCitationIds: [],
        expected: { forbiddenAnswerStrings: ["3"], requiredCitationIds: ["s1"], rubric: ["x"] },
      },
    ],
    ["a missing_source case with a citation", { tags: ["missing_source"] }],
    ["a small hint with nothing it must not say", { expected: { rubric: ["x"] } }],
    ["no rubric", { expected: { forbiddenAnswerStrings: ["3"] } }],
    [
      "an unresolved answer key",
      {
        input: {
          question: { ...mcq, answerKey: { kind: "unresolved" } },
          action: "small_hint",
          passages: [passage],
        },
      },
    ],
    [
      "an action that belongs to another task",
      { input: { question: mcq, action: "full_explanation", passages: [] } },
    ],
    [
      "a multiple-choice question without options",
      { input: { question: { ...mcq, options: [] }, action: "small_hint", passages: [] } },
    ],
    ["an unknown field", { surprise: true }],
  ])("rejects %s", (_l, over) => {
    expect(parse(hintCase(over as Record<string, unknown>)).success).toBe(false);
  });

  it("requires an explanation case to name the answer it should reach", () => {
    const base = hintCase({
      task: "explanation",
      input: { question: mcq, action: "full_explanation", passages: [passage] },
      expected: { rubric: ["x"] },
    });
    expect(parse(base).success).toBe(false);
    expect(parse({ ...base, tags: ["ambiguous"] }).success).toBe(true);
  });
});

describe("loading", () => {
  const jsonl = (...rows: unknown[]) =>
    rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");
  const here = { language: "python", task: "hint" as const };

  it("points at the file and line of each problem and keeps the good lines", () => {
    const { cases, problems } = parse_(
      jsonl(hintCase(), "{ not json", hintCase({ id: "hint-2", review: undefined })),
    );
    expect(cases.map((c) => c.case.id)).toEqual(["hint-1"]);
    expect(problems.map((p) => [p.line, p.message])).toEqual([
      [2, "not valid JSON"],
      [3, expect.stringMatching(/^review/)],
    ]);
    function parse_(s: string) {
      return parseJsonl(s, "evals/python/hint.jsonl", here);
    }
  });

  it("rejects duplicate ids, wrong tasks and wrong languages", () => {
    const { cases, problems } = parseJsonl(
      jsonl(hintCase(), hintCase(), hintCase({ id: "x", language: "java" }), {
        ...hintCase({ id: "y" }),
        task: "short_answer_grading",
      }),
      "f",
      here,
    );
    expect(cases).toHaveLength(1);
    expect(problems.map((p) => p.message.split(" ")[0])).toEqual([
      "duplicate",
      "language",
      expect.any(String),
    ]);
  });

  it("loads the smoke fixtures and reports coverage by task and tag", () => {
    const loaded = loadEvalDir(SMOKE);
    expect(loaded.problems).toEqual([]);
    expect(loaded.cases).toHaveLength(8);
    expect(loaded.cases.every((c) => c.case.kind === "smoke")).toBe(true);
    const table = coverage(loaded.cases);
    expect(table["hint/python"]).toEqual({ total: 2, tags: { missing_source: 1 } });
    expect(Object.keys(table)).toHaveLength(4);
  });

  it("filters by task and language and hashes exactly the files it read", () => {
    const all = loadEvalDir(SMOKE);
    const hints = loadEvalDir(SMOKE, { task: "hint" });
    expect(hints.cases).toHaveLength(2);
    expect(hints.fixtureHash).not.toBe(all.fixtureHash);
    expect(loadEvalDir(SMOKE).fixtureHash).toBe(all.fixtureHash);
    expect(loadEvalDir(SMOKE, { language: "java" }).cases).toEqual([]);
  });

  it("reports a missing folder, unknown task files and ids reused across files", () => {
    expect(loadEvalDir("/definitely/not/here").problems[0]!.message).toMatch(/not found/);
    const dir = mkdtempSync(path.join(os.tmpdir(), "evals-"));
    mkdirSync(path.join(dir, "python"));
    mkdirSync(path.join(dir, "java"));
    writeFileSync(path.join(dir, "python", "poems.jsonl"), "");
    writeFileSync(path.join(dir, "python", "hint.jsonl"), JSON.stringify(hintCase()) + "\n");
    writeFileSync(
      path.join(dir, "java", "hint.jsonl"),
      JSON.stringify(hintCase({ language: "java" })) + "\n",
    );
    const result = loadEvalDir(dir);
    expect(result.cases).toHaveLength(1);
    expect(result.problems.map((p) => p.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unknown task file/),
        expect.stringMatching(/is also used/),
      ]),
    );
  });
});

describe("metrics", () => {
  it("keeps needs_human_review and not_scored out of the rate", () => {
    const t = tallyOf([
      "pass",
      "pass",
      "fail",
      "needs_human_review",
      "needs_human_review",
      "not_scored",
    ]);
    expect(t).toMatchObject({
      pass: 2,
      fail: 1,
      needsHumanReview: 2,
      notScored: 1,
      denominator: 3,
    });
    expect(t.rate).toBeCloseTo(2 / 3);
  });

  it("has no rate when nothing could be judged, never a perfect one", () => {
    expect(tallyOf([]).rate).toBeNull();
    expect(tallyOf(["needs_human_review"]).rate).toBeNull();
  });

  it("computes percentiles", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
  });

  const result = (over: Partial<CaseResult>): CaseResult => ({
    id: "a",
    task: "hint",
    language: "python",
    tags: [],
    status: "completed",
    judgments: {},
    requests: 1,
    notes: [],
    ...over,
  });

  it("counts unvalidated cases and leaves them out of every metric", () => {
    const a = aggregate([
      result({ id: "1", judgments: { hint_leakage: "pass" }, latencyMs: 100 }),
      result({ id: "2", judgments: { hint_leakage: "fail" }, latencyMs: 300, tags: ["ambiguous"] }),
      result({
        id: "3",
        status: "unvalidated",
        errorCode: "ai_quota_exceeded",
        requests: 0,
        judgments: { hint_leakage: "pass" },
      }),
      result({ id: "4", withheld: true, judgments: {} }),
    ]);
    expect(a).toMatchObject({
      total: 4,
      completed: 3,
      unvalidated: 1,
      withheld: 1,
      requestCount: 3,
    });
    expect(a.metrics.hint_leakage).toMatchObject({ pass: 1, fail: 1, denominator: 2 });
    expect(a.latencyMs).toEqual({ count: 2, p50: 100, p95: 300, max: 300 });
    expect(a.tagCounts).toEqual({ ambiguous: 1 });
  });
});

const shaped = (over: Partial<ShapedTutor> = {}): ShapedTutor => ({
  text: "Think about counting.",
  sourceSupported: true,
  citedLocalIds: ["s1"],
  fabricatedIds: [],
  ...over,
});
const hintParsed = () => evalCaseSchema.parse(hintCase()) as Parameters<typeof scoreTutor>[0];

describe("scoring", () => {
  it("passes a hint that stops short and cites an allowed passage", () => {
    expect(scoreTutor(hintParsed(), shaped()).judgments).toMatchObject({
      hint_leakage: "pass",
      citation_validity: "pass",
      step_correctness: "needs_human_review",
    });
  });

  it("fails a hint that states the answer, by the app's rule or the case's forbidden strings", () => {
    expect(
      scoreTutor(hintParsed(), shaped({ text: "The answer is 3." })).judgments.hint_leakage,
    ).toBe("fail");
    expect(
      scoreTutor(hintParsed(), shaped({ text: "It returns three, i.e. 3 items" })).judgments
        .hint_leakage,
    ).toBe("fail");
  });

  it("fails fabricated, disallowed and missing required citations", () => {
    expect(
      scoreTutor(hintParsed(), shaped({ fabricatedIds: ["ghost"] })).judgments.citation_validity,
    ).toBe("fail");
    expect(
      scoreTutor(hintParsed(), shaped({ citedLocalIds: ["other"] })).judgments.citation_validity,
    ).toBe("fail");
    expect(
      scoreTutor(hintParsed(), shaped({ citedLocalIds: [], sourceSupported: true })).judgments
        .citation_validity,
    ).toBe("fail");
  });

  it("scores a refusal by the app's checks as nothing shown, not a pass", () => {
    const out = scoreTutor(hintParsed(), null);
    expect(out.judgments).toEqual({});
    expect(out.notes[0]).toMatch(/nothing would have been shown/);
  });

  it("expects honesty where the case is ambiguous or has no source", () => {
    const c = evalCaseSchema.parse(
      hintCase({
        tags: ["missing_source"],
        allowedCitationIds: [],
        expected: { forbiddenAnswerStrings: ["3"], abstain: true, rubric: ["x"] },
      }),
    ) as Parameters<typeof scoreTutor>[0];
    const sure = scoreTutor(c, shaped({ citedLocalIds: [], sourceSupported: true }));
    expect(sure.judgments.ambiguity_handling).toBe("fail");
    expect(
      scoreTutor(c, shaped({ citedLocalIds: [], sourceSupported: false })).judgments
        .ambiguity_handling,
    ).toBe("pass");
    expect(
      scoreTutor(c, shaped({ citedLocalIds: [], uncertainty: "not sure" })).judgments
        .ambiguity_handling,
    ).toBe("pass");
  });

  it("checks an explanation reaches the expected answer", () => {
    const c = evalCaseSchema.parse(
      hintCase({
        task: "explanation",
        input: { question: mcq, action: "full_explanation", passages: [passage] },
        expected: { acceptedAnswerStrings: ["3 items", "three"], rubric: ["x"] },
      }),
    ) as Parameters<typeof scoreTutor>[0];
    expect(scoreTutor(c, shaped({ text: "It gives 3 items." })).judgments.answer_correctness).toBe(
      "pass",
    );
    expect(scoreTutor(c, shaped({ text: "It gives 2." })).judgments.answer_correctness).toBe(
      "fail",
    );
    expect(scoreTutor(c, shaped({ text: "It gives 2." })).judgments.hint_leakage).toBeUndefined();
  });

  const gen = evalCaseSchema.parse({
    id: "g",
    task: "question_generation",
    language: "python",
    tags: [],
    review,
    sourceVersion: "v1",
    input: {
      course: { title: "C", subject: "S", language: null },
      existingPrompts: ["Old question?"],
      count: 2,
    },
    expected: { forbiddenStrings: ["secret"], rubric: ["x"] },
  }) as Parameters<typeof scoreGeneration>[0];
  const proposal = (over: object = {}) => ({
    type: "mcq_single" as const,
    prompt: "New question?",
    options: ["a", "b", "c", "d"].map((id) => ({ id, text: id.toUpperCase() })),
    correctOptionIds: ["a"],
    explanation: "The answer is A.",
    ...over,
  });

  it("scores generation structurally and leaves meaning to a person", () => {
    const ok = scoreGeneration(gen, { proposals: [proposal(), proposal()], dropped: 0 });
    expect(ok.judgments).toMatchObject({
      generation_yield: "pass",
      answer_correctness: "needs_human_review",
    });
    expect(
      scoreGeneration(gen, { proposals: [proposal()], dropped: 1 }).judgments.generation_yield,
    ).toBe("fail");
  });

  it("fails an explanation that names a different answer, a repeat and forbidden text", () => {
    expect(
      scoreGeneration(gen, {
        proposals: [proposal({ explanation: "The answer is B." })],
        dropped: 0,
      }).judgments.answer_correctness,
    ).toBe("fail");
    expect(
      scoreGeneration(gen, { proposals: [proposal({ prompt: "old question?" })], dropped: 0 })
        .judgments.rubric_agreement,
    ).toBe("fail");
    expect(
      scoreGeneration(gen, { proposals: [proposal({ prompt: "A SECRET plan?" })], dropped: 0 })
        .judgments.rubric_agreement,
    ).toBe("fail");
  });

  const grading = evalCaseSchema.parse({
    id: "gr",
    task: "short_answer_grading",
    language: "python",
    tags: [],
    review,
    sourceVersion: "v1",
    input: {
      question: {
        type: "short_answer",
        prompt: "Q?",
        options: [],
        answerKey: { kind: "text", accepted: ["len"], caseSensitive: true },
      },
      response: { kind: "text", text: "size" },
    },
    expected: { outcome: "incorrect", why: "Not an accepted answer." },
  }) as Parameters<typeof scoreGrading>[0];

  it("counts a wrongly accepted answer on its own", () => {
    expect(scoreGrading(grading, "incorrect").judgments).toMatchObject({
      answer_correctness: "pass",
      false_accept: "pass",
    });
    expect(scoreGrading(grading, "correct").judgments).toMatchObject({
      answer_correctness: "fail",
      false_accept: "fail",
    });
    expect(scoreGrading(grading, "uncertain").judgments.false_accept).toBe("pass");
  });

  it("gives the app's own grading as the baseline", () => {
    const baseline = gradeBaseline([{ case: grading, file: "f", line: 1 }]);
    expect(baseline[0]!.judgments.answer_correctness).toBe("pass");
  });

  it("maps case-local ids to stable, valid UUIDs", () => {
    const id = localUuid("case", "s1");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(localUuid("case", "s1")).toBe(id);
    expect(localUuid("case", "s2")).not.toBe(id);
    expect(localUuid("other", "s1")).not.toBe(id);
  });
});

describe("runner", () => {
  const smoke = loadEvalDir(SMOKE).cases;
  const mock = (c: Parameters<typeof createMockProvider>[0]) => {
    const meter: RequestMeter = { requests: 0 };
    return { provider: createMockProvider(c, meter), meter };
  };

  it("runs every smoke case through the app's own prompts and checks", async () => {
    const out = await runEval({ cases: smoke, makeProvider: mock });
    expect(out.aggregate).toMatchObject({
      total: 8,
      completed: 8,
      unvalidated: 0,
      requestCount: 8,
    });
    expect(out.aggregate.metrics.hint_leakage).toMatchObject({ fail: 0 });
    expect(out.stoppedBecause).toBeUndefined();
  });

  const providerThat = (reply: () => Promise<unknown>): AiProvider => ({
    name: "fake",
    generateStructured: (async () => reply()) as AiProvider["generateStructured"],
    generateText: async () => "",
    streamText: async function* () {},
  });
  const one = smoke.filter((c) => c.case.id === "smoke-hint-source");

  it("counts a hint the app would refuse as withheld, not as passed", async () => {
    const out = await runEval({
      cases: one,
      makeProvider: () => ({
        provider: providerThat(async () => ({
          level: "conceptual_hint",
          text: "The answer is 3.",
          citedSegmentIds: [],
          sourceSupported: false,
        })),
        meter: { requests: 0 },
      }),
    });
    expect(out.results[0]).toMatchObject({ status: "completed", withheld: true, judgments: {} });
    expect(out.aggregate.withheld).toBe(1);
  });

  it("flags a citation to a passage that was never supplied", async () => {
    const out = await runEval({
      cases: one,
      makeProvider: () => ({
        provider: providerThat(async () => ({
          level: "conceptual_hint",
          text: "Think about counting.",
          citedSegmentIds: ["7b1b5a4e-7b0a-4a52-8f0a-111111111111"],
          sourceSupported: true,
        })),
        meter: { requests: 0 },
      }),
    });
    expect(out.results[0]!.judgments.citation_validity).toBe("fail");
    expect(out.results[0]!.notes.join(" ")).toMatch(/not given/);
  });

  it("keeps going after one case fails, and reports it", async () => {
    let n = 0;
    const out = await runEval({
      cases: smoke.filter((c) => c.case.task === "hint"),
      makeProvider: () => ({
        provider: providerThat(async () => {
          if (n++ === 0) throw new Error("boom");
          return {
            level: "conceptual_hint",
            text: "Think.",
            citedSegmentIds: [],
            sourceSupported: false,
            uncertainty: "unsure",
          };
        }),
        meter: { requests: 0 },
      }),
    });
    expect(out.results.map((r) => r.status)).toEqual(["error", "completed"]);
  });

  it("stops at quota, leaves the rest unvalidated and never counts them as passes", async () => {
    let n = 0;
    const out = await runEval({
      cases: smoke,
      makeProvider: () => ({
        provider: providerThat(async () => {
          if (n++ >= 2) throw new AiQuotaExceeded();
          return {
            level: "conceptual_hint",
            text: "Think.",
            citedSegmentIds: [],
            sourceSupported: false,
            uncertainty: "unsure",
          };
        }),
        meter: { requests: 0 },
      }),
    });
    expect(out.stoppedBecause).toBe("quota");
    expect(out.aggregate.unvalidated).toBeGreaterThanOrEqual(5);
    expect(
      out.results
        .filter((r) => r.status === "unvalidated")
        .every((r) => r.errorCode === "ai_quota_exceeded"),
    ).toBe(true);
  });

  it("stops at the request cap and paces calls", async () => {
    const sleep = vi.fn(async () => {});
    const out = await runEval({
      cases: smoke,
      makeProvider: mock,
      maxRequests: 3,
      minIntervalMs: 500,
      sleep,
    });
    expect(out.stoppedBecause).toBe("request_cap");
    expect(out.aggregate.completed).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });
});

describe("request metering", () => {
  it("counts requests and reads token counts when they are reported", async () => {
    const meter: RequestMeter = { requests: 0 };
    const base = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 } }),
        ),
    ) as unknown as typeof fetch;
    const f = meteredFetch(base, meter);
    await f("https://example.test");
    await f("https://example.test");
    expect(meter).toEqual({ requests: 2, inputTokens: 20, outputTokens: 8 });
  });

  it("leaves tokens undefined when none are reported", async () => {
    const meter: RequestMeter = { requests: 0 };
    await meteredFetch(
      (async () => new Response("not json")) as unknown as typeof fetch,
      meter,
    )("https://example.test");
    expect(meter).toEqual({ requests: 1 });
  });
});

describe("command line", () => {
  const KEY = "AIza-test-key-should-never-be-printed";
  function harness(env: Record<string, string> = {}, fetchImpl?: typeof fetch) {
    const out: string[] = [];
    const err: string[] = [];
    const files = new Map<string, string>();
    const deps = {
      env,
      appCommit: () => "abc1234",
      writeFile: (f: string, t: string) => void files.set(f, t),
      log: (l: string) => void out.push(l),
      error: (l: string) => void err.push(l),
      sleep: async () => {},
      fetch: fetchImpl,
      now: () => new Date("2026-11-01T12:00:00Z"),
    };
    return { deps, out, err, files };
  }

  it("runs the mock provider with no key and labels the result smoke evidence", async () => {
    const h = harness();
    expect(await runCli(["--provider", "mock", "--dir", SMOKE], h.deps)).toBe(0);
    const summary = JSON.parse(h.out.join("\n"));
    expect(summary).toMatchObject({
      evidence: "smoke",
      provider: "mock",
      model: "mock",
      total: 8,
      appCommit: "abc1234",
      validatorVersion: "b6.1",
      date: "2026-11-01",
    });
    expect(summary.fixtureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.promptVersions.tutor).toBe("tutor-v1");
    expect(summary.baseline.name).toMatch(/deterministic/);
    expect(summary.needsHumanReview).toMatch(/not scored/);
  });

  it("filters by task", async () => {
    const h = harness();
    await runCli(["--task", "hint", "--dir", SMOKE], h.deps);
    expect(JSON.parse(h.out.join("\n"))).toMatchObject({ task: "hint", total: 2 });
  });

  it("says nothing was scored when there are no checked cases, instead of inventing a result", async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "evals-empty-"));
    const h = harness();
    expect(await runCli(["--task", "hint", "--dir", empty], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join("\n"))).toMatchObject({
      total: 0,
      unvalidated: expect.stringMatching(/no checked cases/),
    });
  });

  it("refuses bad options and invalid fixtures", async () => {
    for (const args of [
      ["--task", "poems"],
      ["--provider", "openai"],
      ["--max-cases", "0"],
      ["--wat"],
      ["--task"],
    ]) {
      const h = harness();
      expect(await runCli(args, h.deps)).toBe(1);
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), "evals-bad-"));
    mkdirSync(path.join(dir, "python"));
    writeFileSync(path.join(dir, "python", "hint.jsonl"), "{}\n");
    const h = harness();
    expect(await runCli(["--dir", dir], h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/hint\.jsonl:1/);
  });

  describe("live mode", () => {
    const checkedDir = () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "evals-live-"));
      mkdirSync(path.join(dir, "python"));
      const rows = ["h1", "h2", "h3"].map((id) =>
        JSON.stringify(hintCase({ id, kind: "checked" })),
      );
      writeFileSync(path.join(dir, "python", "hint.jsonl"), rows.join("\n") + "\n");
      return dir;
    };

    it.each([
      [
        ["--provider", "gemini", "--model", "m", "--max-cases", "1"],
        { GEMINI_API_KEY: KEY },
        "--live",
      ],
      [["--provider", "gemini", "--live", "--max-cases", "1"], { GEMINI_API_KEY: KEY }, "--model"],
      [["--provider", "gemini", "--live", "--model", "m"], { GEMINI_API_KEY: KEY }, "--max-cases"],
      [
        ["--provider", "gemini", "--live", "--model", "m", "--max-cases", "1"],
        {},
        "GEMINI_API_KEY",
      ],
    ])("makes no request without every guard (%#)", async (args, env, missing) => {
      const fetchSpy = vi.fn();
      const h = harness(env, fetchSpy as unknown as typeof fetch);
      expect(await runCli([...args, "--dir", checkedDir()], h.deps)).toBe(1);
      expect(h.err.join("\n")).toContain(missing);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("never sends smoke fixtures to a live model, and --live is for gemini only", async () => {
      const fetchSpy = vi.fn();
      const h = harness({ GEMINI_API_KEY: KEY }, fetchSpy as unknown as typeof fetch);
      expect(
        await runCli(
          ["--provider", "gemini", "--live", "--model", "m", "--max-cases", "2", "--dir", SMOKE],
          h.deps,
        ),
      ).toBe(1);
      expect(await runCli(["--live", "--dir", SMOKE], harness().deps)).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    const reply = (text: object) =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(text) }] } }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 },
        }),
      );

    it("states the expected request count first, counts repairs, and reports tokens", async () => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        // The first reply is unusable JSON for the schema, so the provider makes one repair call.
        if (calls === 1) return reply({ nonsense: true });
        return reply({
          level: "conceptual_hint",
          text: "Think about counting.",
          citedSegmentIds: [],
          sourceSupported: false,
          uncertainty: "unsure",
        });
      }) as unknown as typeof fetch;
      const h = harness({ GEMINI_API_KEY: KEY }, fetchImpl);
      const code = await runCli(
        [
          "--provider",
          "gemini",
          "--live",
          "--model",
          "gemini-test",
          "--max-cases",
          "2",
          "--rpm",
          "60",
          "--dir",
          checkedDir(),
          "--out",
          "evals/runs/x.json",
        ],
        h.deps,
      );
      expect(code).toBe(0);
      expect(h.err[0]).toMatch(/2 case\(s\) with gemini-test\. Expect 2 to 4 requests/);
      const summary = JSON.parse(h.out.join("\n"));
      expect(summary).toMatchObject({
        evidence: "live",
        model: "gemini-test",
        total: 2,
        requestCount: 3,
      });
      expect(summary.tokenUsage).toEqual({ input: 150, output: 60 });
      expect(h.files.has("evals/runs/x.json")).toBe(true);
      // The key is never printed or written.
      expect(h.out.join("") + h.err.join("") + [...h.files.values()].join("")).not.toContain(KEY);
    });

    it("stops on quota with exit code 2 and leaves the rest unvalidated", async () => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        if (calls === 1)
          return reply({
            level: "conceptual_hint",
            text: "Think.",
            citedSegmentIds: [],
            sourceSupported: false,
            uncertainty: "unsure",
          });
        return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), {
          status: 429,
        });
      }) as unknown as typeof fetch;
      const h = harness({ GEMINI_API_KEY: KEY }, fetchImpl);
      const code = await runCli(
        [
          "--provider",
          "gemini",
          "--live",
          "--model",
          "m",
          "--max-cases",
          "3",
          "--rpm",
          "60",
          "--dir",
          checkedDir(),
        ],
        h.deps,
      );
      expect(code).toBe(2);
      const summary = JSON.parse(h.out.join("\n"));
      expect(summary).toMatchObject({ completed: 1, unvalidated: 2, stoppedBecause: "quota" });
      expect(summary.errors).toEqual({ ai_quota_exceeded: 2 });
      expect(calls).toBe(2);
    });
  });
});
