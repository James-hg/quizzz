import { describe, expect, it } from "vitest";
import {
  buildShuffledChoices,
  buildShuffledQuestionOrder,
  mergeQuestionGenerationRequest,
  parseCorrectAnswer,
  parseEditorIntent,
  parseOptionList,
  resolveQuestionTarget,
  summarizeQuestionBatch,
  type EditableQuestion,
} from "./editor-intents";

const q = (id: string, text: string, options: string[] = ["a", "b"]): EditableQuestion => ({
  id,
  text,
  options: options.map((t, i) => ({ id: `${id}-${i}`, text: t, correct: i === 0 })),
});
const draft = {
  questions: [q("1", "What is a list?"), q("2", "What is a tuple?"), q("3", "What is a dict?")],
};

describe("parseEditorIntent", () => {
  it("treats ordinary messages as chat", () => {
    expect(parseEditorIntent("what is recursion?").kind).toBe("chat");
  });

  it("renames a set, understanding quiz and set wording", () => {
    expect(parseEditorIntent("rename this quiz to Week 2 Loops")).toMatchObject({
      kind: "rename_set",
      title: "Week 2 Loops",
    });
    expect(parseEditorIntent("Rename the set as Arrays")).toMatchObject({
      kind: "rename_set",
      title: "Arrays",
    });
    expect(parseEditorIntent("rename this quiz").title).toBeUndefined();
    expect(parseEditorIntent("rename quiz to this quiz").title).toBeUndefined();
  });

  it("recognizes shuffling", () => {
    expect(parseEditorIntent("shuffle the questions").kind).toBe("shuffle_questions");
    expect(parseEditorIntent("Shuffle all the choices").kind).toBe("shuffle_choices");
    expect(parseEditorIntent("shuffle the options in every question").kind).toBe("shuffle_choices");
  });

  it("generates a batch of questions with count and topic", () => {
    expect(parseEditorIntent("generate 5 questions about loops")).toMatchObject({
      kind: "generate_questions",
      count: 5,
      topic: "loops",
    });
    expect(parseEditorIntent("add 3 questions on recursion")).toMatchObject({
      kind: "generate_questions",
      count: 3,
      topic: "recursion",
    });
  });

  it("adds a single question", () => {
    expect(parseEditorIntent("add a question: what is a tuple?")).toMatchObject({
      kind: "add_question",
      questionText: "what is a tuple?",
    });
  });

  it("removes, updates, and rewrites a targeted question", () => {
    expect(parseEditorIntent("remove question 2")).toMatchObject({
      kind: "remove_question",
      target: { type: "ordinal", value: 2 },
    });
    expect(parseEditorIntent("delete the last question").target).toEqual({
      type: "ordinal",
      value: "last",
    });
    expect(parseEditorIntent('rewrite the question "What is a list?"')).toMatchObject({
      kind: "randomize_question",
      target: { type: "text", value: "What is a list?" },
    });
    expect(parseEditorIntent("edit the first question").target).toEqual({
      type: "ordinal",
      value: "first",
    });
  });

  it("extracts update changes", () => {
    const intent = parseEditorIntent(
      'update question 1 text to "What is a set?" options: one; two; three correct answer is 2',
    );
    expect(intent.kind).toBe("update_question");
    expect(intent.changes?.questionText).toBe("What is a set?");
    expect(intent.changes?.options).toEqual(["one", "two", "three correct answer is 2"]);
  });

  it("creates a set with an optional name", () => {
    expect(parseEditorIntent("create a quiz called Python Basics")).toMatchObject({
      kind: "create_set",
      title: "Python Basics",
    });
    expect(parseEditorIntent("make a new quiz").title).toBeUndefined();
  });
});

describe("mergeQuestionGenerationRequest", () => {
  it("keeps earlier answers and fills the gaps from a follow-up", () => {
    expect(mergeQuestionGenerationRequest({ count: 4 }, "about sorting")).toEqual({
      count: 4,
      topic: "sorting",
    });
    expect(mergeQuestionGenerationRequest({ topic: "loops" }, "6")).toEqual({
      count: 6,
      topic: "loops",
    });
  });
});

describe("resolveQuestionTarget", () => {
  it("returns missing without a reference", () => {
    expect(resolveQuestionTarget(draft, undefined)).toEqual({ status: "missing" });
  });

  it("resolves ordinals, first, and last", () => {
    expect(resolveQuestionTarget(draft, { type: "ordinal", value: 2 })).toMatchObject({
      status: "match",
      target: { index: 1 },
    });
    expect(resolveQuestionTarget(draft, { type: "ordinal", value: "first" })).toMatchObject({
      target: { index: 0 },
    });
    expect(resolveQuestionTarget(draft, { type: "ordinal", value: "last" })).toMatchObject({
      target: { index: 2 },
    });
    expect(resolveQuestionTarget(draft, { type: "ordinal", value: 9 })).toEqual({
      status: "missing",
    });
    expect(resolveQuestionTarget({ questions: [] }, { type: "ordinal", value: "last" })).toEqual({
      status: "missing",
    });
  });

  it("matches text exactly, then fuzzily, and reports ambiguity", () => {
    expect(resolveQuestionTarget(draft, { type: "text", value: "WHAT is a tuple?" })).toMatchObject(
      {
        status: "match",
        target: { index: 1 },
      },
    );
    expect(resolveQuestionTarget(draft, { type: "text", value: "tuple" })).toMatchObject({
      status: "match",
      target: { index: 1 },
    });
    const ambiguous = resolveQuestionTarget(draft, { type: "text", value: "what is" });
    expect(ambiguous.status).toBe("ambiguous");
    expect(resolveQuestionTarget(draft, { type: "text", value: "zebra" })).toEqual({
      status: "missing",
    });
    expect(resolveQuestionTarget(draft, { type: "text", value: "  " })).toEqual({
      status: "missing",
    });
  });
});

describe("option and answer parsing", () => {
  it("splits options by newline, pipe, semicolon, or comma and strips numbering", () => {
    expect(parseOptionList("options: 1) red\n2) green\n3) blue")).toEqual(["red", "green", "blue"]);
    expect(parseOptionList("a | b | c")).toEqual(["a", "b", "c"]);
    expect(parseOptionList("a; b")).toEqual(["a", "b"]);
    expect(parseOptionList("a, b, c")).toEqual(["a", "b", "c"]);
    expect(parseOptionList("   ")).toEqual([]);
  });

  it("finds the correct answer by number, exact text, or partial text", () => {
    const options = ["red", "green", "dark blue"];
    expect(parseCorrectAnswer("2", options)).toBe(1);
    expect(parseCorrectAnswer("answer is green", options)).toBe(1);
    expect(parseCorrectAnswer("blue", options)).toBe(2);
    expect(parseCorrectAnswer("7", options)).toBeNull();
    expect(parseCorrectAnswer("purple", options)).toBeNull();
    expect(parseCorrectAnswer("", options)).toBeNull();
  });
});

describe("shuffling", () => {
  const seeded = (values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length]!;
  };

  it("always changes the question order when there is more than one question", () => {
    for (const rng of [() => 0.99, () => 0, seeded([0.1, 0.9, 0.5])]) {
      const { questionIds } = buildShuffledQuestionOrder(draft, rng);
      expect(questionIds).not.toEqual(["1", "2", "3"]);
      expect([...questionIds].sort()).toEqual(["1", "2", "3"]);
    }
  });

  it("keeps a single question as is", () => {
    expect(buildShuffledQuestionOrder({ questions: [q("1", "only")] }).questionIds).toEqual(["1"]);
  });

  it("shuffles choices per question without losing the correct flag", () => {
    const { choicesByQuestionId, summary } = buildShuffledChoices(draft, () => 0.5);
    for (const question of draft.questions) {
      const shuffled = choicesByQuestionId[question.id]!;
      expect(shuffled).toHaveLength(question.options.length);
      expect(shuffled.filter((o) => o.correct)).toHaveLength(1);
    }
    expect(summary).toHaveLength(3);
  });
});

describe("summaries", () => {
  it("marks correct options and truncates long text", () => {
    const lines = summarizeQuestionBatch([q("1", "x".repeat(200), ["yes", "no"])]);
    expect(lines[0]).toMatch(/^Question 1: x+\.\.\.$/);
    expect(lines[1]).toBe("  1. yes [correct]");
    expect(lines[2]).toBe("  2. no");
  });
});
