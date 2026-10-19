import { describe, expect, it } from "vitest";
import { contentToRevision, questionContentSchema, revisionToContentInput } from "./question-input";

const opts = [
  { id: "a", text: "1" },
  { id: "b", text: "2" },
  { id: "c", text: "3" },
];

const single = (correctOptionIds: string[], options = opts) => ({
  type: "mcq_single",
  prompt: "Pick one",
  options,
  correctOptionIds,
});

describe("questionContentSchema", () => {
  it("accepts an MCQ with exactly one correct option", () => {
    expect(questionContentSchema.safeParse(single(["b"])).success).toBe(true);
  });

  it("rejects single-answer MCQ with 0 or 2+ correct options", () => {
    expect(questionContentSchema.safeParse(single([])).success).toBe(false);
    expect(questionContentSchema.safeParse(single(["a", "b"])).success).toBe(false);
  });

  it("rejects duplicate option ids and unknown correct ids", () => {
    const dup = [opts[0]!, { id: "a", text: "again" }];
    expect(questionContentSchema.safeParse(single(["a"], dup)).success).toBe(false);
    expect(questionContentSchema.safeParse(single(["zzz"])).success).toBe(false);
  });

  it("requires at least 2 options", () => {
    expect(questionContentSchema.safeParse(single(["a"], [opts[0]!])).success).toBe(false);
  });

  it("allows several correct options for mcq_multi but at least one", () => {
    const multi = (ids: string[]) => ({ ...single(ids), type: "mcq_multi" });
    expect(questionContentSchema.safeParse(multi(["a", "c"])).success).toBe(true);
    expect(questionContentSchema.safeParse(multi([])).success).toBe(false);
  });

  it("requires non-empty accepted answers for text types", () => {
    const text = (accepted: string[]) => ({ type: "short_answer", prompt: "Q", accepted });
    expect(questionContentSchema.safeParse(text(["42"])).success).toBe(true);
    expect(questionContentSchema.safeParse(text([])).success).toBe(false);
    expect(questionContentSchema.safeParse(text(["  "])).success).toBe(false);
  });

  it("requires every blank to have an accepted answer", () => {
    const fill = (blanks: string[][]) => ({ type: "fill_blank", prompt: "x = __", blanks });
    expect(questionContentSchema.safeParse(fill([["1"], ["2", "two"]])).success).toBe(true);
    expect(questionContentSchema.safeParse(fill([[]])).success).toBe(false);
  });
});

describe("revision mapping", () => {
  it("round-trips content through revision columns", () => {
    const content = questionContentSchema.parse(single(["b"]));
    const columns = contentToRevision(content);
    expect(columns.answerKey).toEqual({ kind: "options", correctOptionIds: ["b"] });
    expect(questionContentSchema.parse(revisionToContentInput(columns))).toEqual({
      ...content,
      codeSnippet: null,
      explanation: null,
    });
  });
});
