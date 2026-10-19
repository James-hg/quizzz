import { describe, expect, it } from "vitest";
import type { OwnerQuestionView } from "@/lib/client/types";
import {
  changeType,
  draftFromQuestion,
  draftToInput,
  emptyDraft,
  parseAlternatives,
  validateDraft,
} from "./draft";

const mcq = () => ({
  ...emptyDraft("mcq_single"),
  prompt: "Pick b",
  options: [
    { id: "a", text: "A" },
    { id: "b", text: "B" },
  ],
  correctOptionIds: ["b"],
});

describe("validateDraft", () => {
  it("accepts a complete multiple-choice question", () => {
    const result = validateDraft(mcq());
    expect(result.ok).toBe(true);
  });

  it("requires a prompt, option text, and a correct answer", () => {
    const result = validateDraft({
      ...mcq(),
      prompt: "  ",
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "" },
      ],
      correctOptionIds: [],
    });
    expect(result).toMatchObject({
      ok: false,
      errors: {
        prompt: "Write the question.",
        options: "Every option needs text.",
        correctOptionIds: "Choose the correct answer.",
      },
    });
  });

  it("rejects two correct answers on a single-answer question but allows them for multi", () => {
    const two = { ...mcq(), correctOptionIds: ["a", "b"] };
    expect(validateDraft(two)).toMatchObject({
      ok: false,
      errors: { correctOptionIds: "Choose exactly one correct answer." },
    });
    expect(validateDraft({ ...two, type: "mcq_multi" }).ok).toBe(true);
  });

  it("requires at least one accepted answer for text questions", () => {
    const text = { ...emptyDraft("short_answer"), prompt: "Name it", accepted: ["", "  "] };
    expect(validateDraft(text)).toMatchObject({
      ok: false,
      errors: { accepted: expect.any(String) },
    });
    expect(validateDraft({ ...text, accepted: ["tuple"] }).ok).toBe(true);
  });

  it("requires every blank to have an answer", () => {
    const blank = { ...emptyDraft("fill_blank"), prompt: "x = __ and y = __", blanks: [["1"], []] };
    expect(validateDraft(blank)).toMatchObject({
      ok: false,
      errors: { blanks: expect.any(String) },
    });
    expect(validateDraft({ ...blank, blanks: [["1"], ["2", "two"]] }).ok).toBe(true);
  });
});

describe("draft mapping", () => {
  it("trims text, nulls empty optional fields, and never trims code", () => {
    const input = draftToInput({ ...mcq(), codeSnippet: "  print(1)\n", explanation: "  " });
    expect(input).toMatchObject({ codeSnippet: "  print(1)\n", explanation: null });
  });

  it("round-trips an owner question and marks approval from its evidence state", () => {
    const question: OwnerQuestionView = {
      id: "q",
      questionSetId: "s",
      position: 0,
      status: "active",
      revisionId: "r",
      revisionNumber: 2,
      type: "short_answer",
      prompt: "Name it",
      codeSnippet: null,
      options: [],
      answerKey: { kind: "text", accepted: ["tuple"], caseSensitive: true },
      explanation: null,
      origin: "original",
      evidenceStatus: "human_reviewed",
    };
    const draft = draftFromQuestion(question);
    expect(draft).toMatchObject({ accepted: ["tuple"], caseSensitive: true, approve: true });
    expect(validateDraft(draft).ok).toBe(true);
  });

  it("starts an unresolved question with no correct option selected", () => {
    const draft = draftFromQuestion({
      id: "q",
      questionSetId: "s",
      position: 0,
      status: "excluded",
      revisionId: "r",
      revisionNumber: 1,
      type: "mcq_single",
      prompt: "Imported",
      codeSnippet: null,
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      answerKey: { kind: "unresolved" },
      explanation: null,
      origin: "original",
      evidenceStatus: "unresolved",
    });
    expect(draft.correctOptionIds).toEqual([]);
    expect(validateDraft(draft)).toMatchObject({
      ok: false,
      errors: { correctOptionIds: expect.any(String) },
    });
  });

  it("changeType trims to one correct option and makes output prediction case sensitive", () => {
    const multi = { ...mcq(), type: "mcq_multi" as const, correctOptionIds: ["a", "b"] };
    expect(changeType(multi, "mcq_single").correctOptionIds).toEqual(["a"]);
    expect(changeType(mcq(), "output_prediction").caseSensitive).toBe(true);
  });

  it("parses alternatives separated by pipes", () => {
    expect(parseAlternatives(" range | xrange ||")).toEqual(["range", "xrange"]);
  });
});
