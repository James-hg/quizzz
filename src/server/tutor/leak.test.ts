import { describe, expect, it } from "vitest";
import type { AnswerKey } from "@/lib/schemas";
import { leaksAnswer } from "./leak";

const options = [
  { id: "a", text: "A stack" },
  { id: "b", text: "A queue" },
  { id: "c", text: "A tree" },
];
const mcq: AnswerKey = { kind: "options", correctOptionIds: ["b"] };

describe("leaksAnswer", () => {
  it("refuses the correct option text, in any case and spacing", () => {
    expect(leaksAnswer("Think about a QUEUE here.", mcq, options)).toBe(true);
    expect(leaksAnswer("it is  a   queue!", mcq, options)).toBe(true);
  });

  it("refuses 'option B' style disclosures", () => {
    for (const text of [
      "Option B.",
      "The answer is B",
      "choose (B)",
      "Option b is right",
      "answer: b",
    ]) {
      expect(leaksAnswer(text, mcq, options), text).toBe(true);
    }
  });

  it("does not trip on unrelated one-letter words or other options", () => {
    expect(leaksAnswer("Read the question and note a key word.", mcq, options)).toBe(false);
    expect(leaksAnswer("Rule out a stack: it removes the newest item.", mcq, options)).toBe(false);
    expect(leaksAnswer("Think about first-in, first-out order.", mcq, options)).toBe(false);
  });

  it("checks accepted text answers and blanks", () => {
    const text: AnswerKey = {
      kind: "text",
      accepted: ["Binary Search", "bsearch"],
      caseSensitive: false,
    };
    expect(leaksAnswer("Use binary   search.", text, [])).toBe(true);
    expect(leaksAnswer("Halve the range each step.", text, [])).toBe(false);
    const blanks: AnswerKey = {
      kind: "blanks",
      blanks: [["O(n)"], ["stack"]],
      caseSensitive: false,
    };
    expect(leaksAnswer("The second blank is a stack.", blanks, [])).toBe(true);
    expect(leaksAnswer("Think about last in first out.", blanks, [])).toBe(false);
  });

  it("only counts a single-character answer when stated as the answer", () => {
    const num: AnswerKey = { kind: "text", accepted: ["7"], caseSensitive: false };
    expect(leaksAnswer("The answer is 7.", num, [])).toBe(true);
    expect(leaksAnswer("Add 3 and 4 together.", num, [])).toBe(false);
    expect(leaksAnswer("There are 7 days in a week, but that is unrelated.", num, [])).toBe(false);
  });

  it("has nothing to leak for an unresolved key", () => {
    expect(leaksAnswer("Anything", { kind: "unresolved" }, [])).toBe(false);
  });
});
