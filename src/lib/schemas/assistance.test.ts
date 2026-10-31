import { describe, expect, it } from "vitest";
import {
  ASSISTANCE_LEVELS,
  assistanceRank,
  helpEventInputSchema,
  isUnaided,
  strongestAssistance,
} from "./assistance";
import { DEFAULT_POLICY_VERSION, schedulerPolicyConfigSchema } from "./scheduler";

describe("assistance levels", () => {
  it("are ordered weakest to strongest", () => {
    expect(ASSISTANCE_LEVELS).toEqual([
      "none",
      "conceptual_hint",
      "next_step_hint",
      "partial_example",
      "full_explanation",
      "solution_revealed",
    ]);
    expect(assistanceRank("none")).toBe(0);
    expect(assistanceRank("solution_revealed")).toBe(5);
  });

  it("takes the strongest level used before an answer", () => {
    expect(strongestAssistance([])).toBe("none");
    expect(strongestAssistance(["conceptual_hint", "next_step_hint"])).toBe("next_step_hint");
    expect(strongestAssistance(["partial_example", "conceptual_hint"])).toBe("partial_example");
    expect(strongestAssistance(["none", "solution_revealed", "full_explanation"])).toBe(
      "solution_revealed",
    );
  });

  it("only 'none' counts as unaided", () => {
    expect(isUnaided("none")).toBe(true);
    expect(isUnaided("conceptual_hint")).toBe(false);
  });
});

describe("helpEventInputSchema", () => {
  const base = {
    sessionId: crypto.randomUUID(),
    questionId: crypto.randomUUID(),
    pass: 1 as const,
    action: "small_hint" as const,
    level: "conceptual_hint" as const,
  };

  it("needs an approved hint or the text that was shown", () => {
    expect(helpEventInputSchema.safeParse(base).success).toBe(false);
    expect(
      helpEventInputSchema.safeParse({ ...base, contentText: "Think about loops" }).success,
    ).toBe(true);
    expect(
      helpEventInputSchema.safeParse({ ...base, approvedHintId: crypto.randomUUID() }).success,
    ).toBe(true);
  });

  it("rejects levels that are not help text, unknown actions, and bad turns", () => {
    const ok = { ...base, contentText: "x" };
    expect(helpEventInputSchema.safeParse({ ...ok, level: "none" }).success).toBe(false);
    expect(helpEventInputSchema.safeParse({ ...ok, level: "solution_revealed" }).success).toBe(
      false,
    );
    expect(helpEventInputSchema.safeParse({ ...ok, action: "cheat" }).success).toBe(false);
    expect(helpEventInputSchema.safeParse({ ...ok, pass: 3 }).success).toBe(false);
  });
});

describe("schedulerPolicyConfigSchema", () => {
  const v1 = {
    inSessionRetry: { maxRetries: 1 },
    intervalsDays: [1, 3, 7, 14],
    assistedAdvances: false,
    onLapse: { stepBack: 1 },
  };

  it("accepts the v1 policy and names the default version", () => {
    expect(schedulerPolicyConfigSchema.parse(v1)).toEqual(v1);
    expect(DEFAULT_POLICY_VERSION).toBe("v1");
  });

  it.each([
    ["unknown top-level key", { ...v1, interval: [1] }],
    ["unknown nested key", { ...v1, onLapse: { stepBack: 1, extra: true } }],
    ["no intervals", { ...v1, intervalsDays: [] }],
    ["intervals that do not increase", { ...v1, intervalsDays: [1, 7, 3] }],
    ["repeated intervals", { ...v1, intervalsDays: [1, 1, 3] }],
    ["zero or negative interval", { ...v1, intervalsDays: [0, 3] }],
    ["fractional interval", { ...v1, intervalsDays: [1.5, 3] }],
    ["too many retries", { ...v1, inSessionRetry: { maxRetries: 9 } }],
    ["stepping back further than there are intervals", { ...v1, onLapse: { stepBack: 5 } }],
    ["a non-boolean flag", { ...v1, assistedAdvances: "no" }],
    ["a missing field", { intervalsDays: [1, 3] }],
  ])("rejects %s", (_name, config) => {
    expect(schedulerPolicyConfigSchema.safeParse(config).success).toBe(false);
  });
});
