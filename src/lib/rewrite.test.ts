import { describe, expect, it } from "vitest";
import type { QuestionContent } from "@/lib/schemas";
import { checkProposal, hasNumbers, numbersIn, provenanceFor, sameNumbers } from "./rewrite";

const mcq = (
  over: Partial<Extract<QuestionContent, { type: "mcq_single" }>> = {},
): QuestionContent => ({
  type: "mcq_single",
  prompt: "What is 3 + 4?",
  options: [
    { id: "a", text: "7" },
    { id: "b", text: "8" },
    { id: "c", text: "12" },
  ],
  correctOptionIds: ["a"],
  ...over,
});

const text = (over: Record<string, unknown> = {}): QuestionContent =>
  ({
    type: "short_answer",
    prompt: "Add 2 and 5.",
    accepted: ["7"],
    caseSensitive: false,
    ...over,
  }) as QuestionContent;

describe("numbers", () => {
  it("finds integers, decimals and negatives, and ignores words", () => {
    expect(numbersIn("x = 3 + -2.5 * 10 in base ten")).toEqual(["3", "-2.5", "10"]);
    expect(numbersIn("no digits here")).toEqual([]);
  });

  it("compares as a multiset, so order does not matter", () => {
    expect(sameNumbers("3 then 4", "4 then 3")).toBe(true);
    expect(sameNumbers("3 and 4", "3 and 5")).toBe(false);
    expect(hasNumbers({ prompt: "What is x?", codeSnippet: "x = 1" })).toBe(true);
    expect(hasNumbers({ prompt: "What is x?", codeSnippet: null })).toBe(false);
  });
});

describe("provenanceFor", () => {
  it("labels each mode, and always sends varied numbers to review", () => {
    expect(provenanceFor("rephrase")).toEqual({
      origin: "ai_variant",
      evidenceStatus: "generated_unreviewed",
    });
    expect(provenanceFor("add_explanation")).toEqual({
      origin: "ai_proposed",
      evidenceStatus: "generated_unreviewed",
    });
    expect(provenanceFor("vary_numbers")).toEqual({
      origin: "ai_variant",
      evidenceStatus: "needs_review",
    });
  });
});

describe("checkProposal: rephrase", () => {
  const reworded = mcq({
    prompt: "Work out 3 plus 4.",
    options: [
      { id: "a", text: "seven (7)" },
      { id: "b", text: "eight (8)" },
      { id: "c", text: "twelve (12)" },
    ],
  });

  it("accepts new wording that keeps ids, answer, code and numbers", () => {
    expect(checkProposal("rephrase", mcq(), reworded)).toBeNull();
  });

  it.each([
    [
      "a different answer",
      mcq({ prompt: "Work out 3 plus 4.", correctOptionIds: ["b"] }),
      /answer changed/,
    ],
    [
      "a removed option",
      mcq({
        prompt: "Reworded 3 + 4",
        options: [
          { id: "a", text: "7" },
          { id: "b", text: "8" },
        ],
      }),
      /options were added, removed or reordered/,
    ],
    [
      "reordered options",
      mcq({
        prompt: "Reworded 3 + 4",
        options: [
          { id: "b", text: "8" },
          { id: "a", text: "7" },
          { id: "c", text: "12" },
        ],
      }),
      /reordered/,
    ],
    ["changed numbers", mcq({ prompt: "What is 3 + 5?" }), /numbers changed/],
    ["no change at all", mcq(), /nothing was rephrased/],
  ])("rejects %s", (_name, proposed, reason) => {
    expect(checkProposal("rephrase", mcq(), proposed)).toMatch(reason);
  });

  it("rejects a changed type and a changed answer on text questions", () => {
    expect(checkProposal("rephrase", mcq(), text())).toMatch(/type changed/);
    expect(
      checkProposal("rephrase", text(), text({ prompt: "Sum 2 and 5.", accepted: ["8"] })),
    ).toMatch(/answer changed/);
    expect(checkProposal("rephrase", text(), text({ prompt: "Sum 2 and 5." }))).toBeNull();
  });
});

describe("checkProposal: add_explanation", () => {
  it("accepts a new explanation and nothing else", () => {
    expect(checkProposal("add_explanation", mcq(), mcq({ explanation: "3 + 4 is 7." }))).toBeNull();
  });

  it.each([
    ["no explanation", mcq(), /no explanation/],
    ["an unchanged explanation", mcq({ explanation: "Same." }), /did not change/],
    [
      "a changed prompt",
      mcq({ explanation: "Because.", prompt: "What is 3 + 5?" }),
      /only the explanation/,
    ],
    [
      "a changed answer",
      mcq({ explanation: "Because.", correctOptionIds: ["b"] }),
      /only the explanation/,
    ],
  ])("rejects %s", (_name, proposed, reason) => {
    const original = _name === "an unchanged explanation" ? mcq({ explanation: "Same." }) : mcq();
    expect(checkProposal("add_explanation", original, proposed)).toMatch(reason);
  });
});

describe("checkProposal: vary_numbers", () => {
  const varied = mcq({
    prompt: "What is 5 + 6?",
    options: [
      { id: "a", text: "11" },
      { id: "b", text: "12" },
      { id: "c", text: "56" },
    ],
  });

  it("accepts a question with different numbers and its own options", () => {
    expect(checkProposal("vary_numbers", mcq(), varied)).toBeNull();
  });

  it("rejects unchanged numbers, a copied answer, and a question without numbers", () => {
    expect(checkProposal("vary_numbers", mcq(), mcq({ prompt: "Compute 4 + 3." }))).toMatch(
      /numbers did not change/,
    );
    expect(checkProposal("vary_numbers", mcq(), mcq({ prompt: "What is 5 + 6?" }))).toMatch(
      /copied/,
    );
    expect(
      checkProposal(
        "vary_numbers",
        text({ prompt: "Name it." }),
        text({ prompt: "Name 3 of them." }),
      ),
    ).toMatch(/no numbers/);
  });

  it("rejects a text answer carried over unchanged", () => {
    expect(checkProposal("vary_numbers", text(), text({ prompt: "Add 3 and 9." }))).toMatch(
      /copied/,
    );
    expect(
      checkProposal("vary_numbers", text(), text({ prompt: "Add 3 and 9.", accepted: ["12"] })),
    ).toBeNull();
  });
});
