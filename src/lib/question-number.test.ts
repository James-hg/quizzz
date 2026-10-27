import { describe, expect, it } from "vitest";
import { QUESTION_PREFIX } from "@/server/import/mcq-detect";
import { hasQuestionNumber, stripQuestionNumber } from "./question-number";

describe("stripQuestionNumber: numbering that is removed", () => {
  it.each([
    ["1. What is X?", "What is X?"],
    ["10. What is X?", "What is X?"],
    ["123. What is X?", "What is X?"],
    ["1) What is X?", "What is X?"],
    ["  7.   What is X?", "What is X?"],
    ["(1) What is X?", "What is X?"],
    ["( 12 ) What is X?", "What is X?"],
    ["Question 3 What is X?", "What is X?"],
    ["Question 3: What is X?", "What is X?"],
    ["Question 3. What is X?", "What is X?"],
    ["Question 12) What is X?", "What is X?"],
    ["question 3 - What is X?", "What is X?"],
    ["Q3. What is X?", "What is X?"],
    ["Q3) What is X?", "What is X?"],
    ["Q3: What is X?", "What is X?"],
    ["Q3 What is X?", "What is X?"],
    ["Q.3 What is X?", "What is X?"],
    ["1. 5 + 3 = ?", "5 + 3 = ?"],
    ["2. Evaluate:\nx = 1", "Evaluate:\nx = 1"],
  ])("%j -> %j", (input, expected) => {
    expect(stripQuestionNumber(input)).toEqual({ text: expected, removed: true });
  });
});

describe("stripQuestionNumber: content that merely starts with a number is left alone", () => {
  it.each([
    "2 + 2 = ?",
    "5 - 3 = ?",
    "3 apples cost 6. What does one cost?",
    "1.2 mg of X equals how many ug?",
    "2018. Which release added this?",
    "1234) What is X?",
    "3: 4 is the ratio of what?",
    "10 students sit an exam. How many pass?",
    "Q: What is X?",
    "Question: what is X?",
    "Questions 1 and 2 are related.",
    "What is 1. the first thing?",
    "(a) What is X?",
    "",
    "   ",
  ])("%j", (input) => {
    expect(stripQuestionNumber(input)).toEqual({ text: input, removed: false });
  });

  it("never leaves an empty prompt", () => {
    for (const input of ["1.", "1. ", "Question 3:", "(2)", "Q4."]) {
      expect(stripQuestionNumber(input)).toEqual({ text: input, removed: false });
    }
  });
});

describe("stripQuestionNumber: properties", () => {
  const bodies = ["What is X?", "Which of these is true?", "x = 1; print(x)", "Évaluez ceci"];

  it("removes any one-to-three digit number before each delimiter", () => {
    for (const n of [1, 2, 9, 10, 99, 100, 999]) {
      for (const body of bodies) {
        for (const prefix of [`${n}. `, `${n}) `, `(${n}) `, `Question ${n}: `, `Q${n}. `]) {
          expect(stripQuestionNumber(`${prefix}${body}`).text, prefix).toBe(body);
        }
      }
    }
  });

  it("is a no-op for text that does not start with a digit, '(' or Q", () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    const alphabet = "abcdefghijklmnoprstuvwxyz .,:;)-?!";
    for (let i = 0; i < 200; i++) {
      let text = "";
      for (let j = 0, n = 1 + (next() % 30); j < n; j++) text += alphabet[next() % alphabet.length];
      expect(stripQuestionNumber(text).text).toBe(text);
    }
  });

  it("strips at most one number, from the start only", () => {
    expect(stripQuestionNumber("1. 2. What is X?").text).toBe("2. What is X?");
    expect(stripQuestionNumber("What is 1. the first?").removed).toBe(false);
  });

  it("agrees with QUESTION_PREFIX, the rule the importer already applies to typed paragraphs", () => {
    const samples = [
      "1. What",
      "12) What",
      "Question 3 What",
      "question  4 What",
      "Q5 What",
      "q6 What",
      "7. What is 5 + 5?",
      "Q10 What",
    ];
    for (const sample of samples) {
      expect(QUESTION_PREFIX.test(sample), sample).toBe(true);
      expect(stripQuestionNumber(sample).text, sample).toBe(
        sample.replace(QUESTION_PREFIX, "").trim(),
      );
    }
  });

  it("hasQuestionNumber matches stripQuestionNumber", () => {
    expect(hasQuestionNumber("1. What")).toBe(true);
    expect(hasQuestionNumber("2 + 2 = ?")).toBe(false);
  });
});
