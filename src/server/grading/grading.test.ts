import { describe, expect, it } from "vitest";
import type { AnswerKey, QuestionResponse } from "@/lib/schemas";
import { gradeResponse, revealAnswer } from "./index";
import { normalizeText, outputLines } from "./normalize";

const options = (...ids: string[]): QuestionResponse => ({
  kind: "options",
  selectedOptionIds: ids,
});
const text = (value: string): QuestionResponse => ({ kind: "text", text: value });
const blanks = (...values: string[]): QuestionResponse => ({ kind: "blanks", values });

const optKey = (...ids: string[]): AnswerKey => ({ kind: "options", correctOptionIds: ids });
const textKey = (accepted: string[], caseSensitive = false): AnswerKey => ({
  kind: "text",
  accepted,
  caseSensitive,
});

describe("normalizeText", () => {
  it("trims, collapses whitespace, and folds case unless case sensitive", () => {
    expect(normalizeText("  Hello \t  World\n", false)).toBe("hello world");
    expect(normalizeText("  Hello  World ", true)).toBe("Hello World");
  });

  it("treats composed and decomposed accents as equal", () => {
    expect(normalizeText("é", false)).toBe(normalizeText("é", false));
  });
});

describe("outputLines", () => {
  it("ignores trailing whitespace, CRLF, and trailing blank lines but not leading spaces", () => {
    expect(outputLines("a  \r\nb\t\n\n\n", true)).toEqual(["a", "b"]);
    expect(outputLines("  a", true)).toEqual(["  a"]);
  });
});

describe("mcq grading", () => {
  it("mcq_single: exactly the key is correct", () => {
    const q = { type: "mcq_single", answerKey: optKey("b") };
    expect(gradeResponse(q, options("b"))).toBe("correct");
    expect(gradeResponse(q, options("a"))).toBe("incorrect");
    expect(gradeResponse(q, options("a", "b"))).toBe("incorrect");
    expect(gradeResponse(q, options())).toBe("incorrect");
  });

  it("mcq_multi: exact set match, order and duplicates irrelevant", () => {
    const q = { type: "mcq_multi", answerKey: optKey("a", "c") };
    expect(gradeResponse(q, options("c", "a"))).toBe("correct");
    expect(gradeResponse(q, options("a", "a", "c"))).toBe("correct");
    expect(gradeResponse(q, options("a"))).toBe("incorrect");
    expect(gradeResponse(q, options("a", "b", "c"))).toBe("incorrect");
  });
});

describe("text grading", () => {
  it("short_answer: normalized match against any accepted answer", () => {
    const q = { type: "short_answer", answerKey: textKey(["Tuple", "a tuple"]) };
    expect(gradeResponse(q, text("  TUPLE "))).toBe("correct");
    expect(gradeResponse(q, text("a   tuple"))).toBe("correct");
    expect(gradeResponse(q, text("list"))).toBe("incorrect");
    expect(gradeResponse(q, text(""))).toBe("incorrect");
  });

  it("short_answer: honors the case-sensitive flag", () => {
    const q = { type: "short_answer", answerKey: textKey(["None"], true) };
    expect(gradeResponse(q, text("None"))).toBe("correct");
    expect(gradeResponse(q, text("none"))).toBe("incorrect");
  });

  it("fill_blank: every blank must match, and the count must agree", () => {
    const q = {
      type: "fill_blank",
      answerKey: {
        kind: "blanks",
        blanks: [["for"], ["range", "xrange"]],
        caseSensitive: false,
      } as AnswerKey,
    };
    expect(gradeResponse(q, blanks("FOR", " range "))).toBe("correct");
    expect(gradeResponse(q, blanks("for", "xrange"))).toBe("correct");
    expect(gradeResponse(q, blanks("for", "len"))).toBe("incorrect");
    expect(gradeResponse(q, blanks("for"))).toBe("incorrect");
    expect(gradeResponse(q, blanks("for", "range", "extra"))).toBe("incorrect");
  });

  it("output_prediction: line by line, trailing whitespace tolerated", () => {
    const q = { type: "output_prediction", answerKey: textKey(["1\n2\n3"], true) };
    expect(gradeResponse(q, text("1  \n2\r\n3\n\n"))).toBe("correct");
    expect(gradeResponse(q, text("1\n3\n2"))).toBe("incorrect");
    expect(gradeResponse(q, text("1\n2"))).toBe("incorrect");
    expect(gradeResponse(q, text("True"))).toBe("incorrect");
  });

  it("output_prediction: accepts any listed output and respects case flag", () => {
    const q = { type: "output_prediction", answerKey: textKey(["True", "true"], true) };
    expect(gradeResponse(q, text("true"))).toBe("correct");
    expect(gradeResponse(q, text("TRUE"))).toBe("incorrect");
  });
});

describe("uncertain outcomes", () => {
  it("is uncertain, not incorrect, for unknown types and mismatched shapes", () => {
    expect(gradeResponse({ type: "essay", answerKey: textKey(["x"]) }, text("x"))).toBe(
      "uncertain",
    );
    expect(gradeResponse({ type: "mcq_single", answerKey: optKey("a") }, text("a"))).toBe(
      "uncertain",
    );
    expect(gradeResponse({ type: "short_answer", answerKey: optKey("a") }, text("a"))).toBe(
      "uncertain",
    );
    expect(gradeResponse({ type: "fill_blank", answerKey: textKey(["a"]) }, blanks("a"))).toBe(
      "uncertain",
    );
  });
});

describe("revealAnswer", () => {
  it("drops everything except the answer itself", () => {
    expect(revealAnswer(textKey(["x"], true))).toEqual({ kind: "text", accepted: ["x"] });
  });
});
