import { describe, expect, it } from "vitest";
import {
  afterEffect,
  helpMessage,
  START,
  step,
  type CommandQuestion,
  type Effect,
  type FlowContext,
  type FlowResult,
  type Pending,
} from "./command-flow";

const q = (
  id: string,
  text: string,
  options: string[] = ["red", "green", "blue"],
  correct = 0,
  type = "mcq_single",
): CommandQuestion => ({
  id,
  text,
  type,
  options: options.map((t, i) => ({ id: `${id}-${i}`, text: t, correct: i === correct })),
});

const ctx = (over: Partial<FlowContext> = {}): FlowContext => ({
  setTitle: "Week 1",
  aiEnabled: false,
  questions: [q("q1", "What is a list?"), q("q2", "What is a tuple?"), q("q3", "What is a dict?")],
  ...over,
});

/** Feeds several messages through the flow, returning every result. */
function talk(inputs: string[], c: FlowContext = ctx(), from: Pending = START): FlowResult[] {
  const results: FlowResult[] = [];
  let state = from;
  for (const input of inputs) {
    const result = step(state, input, c);
    results.push(result);
    state = result.state;
  }
  return results;
}
const last = (r: FlowResult[]) => r[r.length - 1]!;
const text = (r: FlowResult) => r.messages.join(" ");

describe("rename a set", () => {
  it("confirms an explicit title, then runs the rename", () => {
    const [ask, yes] = talk(["rename this set to Week 2", "yes"]);
    expect(ask!.state).toMatchObject({
      kind: "confirm",
      effect: { type: "rename_set", title: "Week 2" },
    });
    expect(yes!.run).toEqual({ type: "rename_set", title: "Week 2" });
    expect(yes!.state).toEqual(START);
  });

  it("asks for a name when AI is off and none was given", () => {
    const results = talk(["rename this quiz", "Loops and lists", "confirm"]);
    expect(results[0]!.state.kind).toBe("ask_rename_title");
    expect(last(results).run).toEqual({ type: "rename_set", title: "Loops and lists" });
  });

  it("asks the AI for a name when it is on, and confirms the suggestion", () => {
    const c = ctx({ aiEnabled: true });
    const first = step(START, "rename this set", c);
    expect(first.run).toEqual({ type: "suggest_title" });
    const after = afterEffect(first.run!, { ok: true, data: { title: "Python basics" } }, c);
    expect(after.state).toMatchObject({
      kind: "confirm",
      effect: { type: "rename_set", title: "Python basics" },
    });
    expect(text(after)).toContain("AI-suggested");
  });

  it("does not ask the AI for a name when the set is empty", () => {
    const result = step(START, "rename this set", ctx({ aiEnabled: true, questions: [] }));
    expect(result.run).toBeUndefined();
    expect(text(result)).toContain("Add some questions first");
  });
});

describe("create a set", () => {
  it("uses a given title and confirms", () => {
    const [ask, yes] = talk(["create a quiz called Practice", "yes"]);
    expect(ask!.state).toMatchObject({
      kind: "confirm",
      effect: { type: "create_set", title: "Practice" },
    });
    expect(yes!.run).toEqual({ type: "create_set", title: "Practice" });
  });

  it("asks for a title when missing", () => {
    const results = talk(["make a new quiz", "Exam prep", "yes"]);
    expect(results[0]!.state.kind).toBe("ask_create_title");
    expect(last(results).run).toEqual({ type: "create_set", title: "Exam prep" });
  });
});

describe("shuffle", () => {
  it("previews a new order that differs from the current one, then reorders", () => {
    const [ask, yes] = talk(["shuffle the questions", "yes"]);
    const effect = (ask!.state as Extract<Pending, { kind: "confirm" }>).effect;
    expect(effect.type).toBe("reorder");
    const ids = (effect as { questionIds: string[] }).questionIds;
    expect([...ids].sort()).toEqual(["q1", "q2", "q3"]);
    expect(ids).not.toEqual(["q1", "q2", "q3"]);
    expect(yes!.run).toBe(effect);
  });

  it("needs at least two questions to shuffle", () => {
    expect(
      text(step(START, "shuffle the questions", ctx({ questions: [q("q1", "only")] }))),
    ).toContain("at least two");
  });

  it("shuffles the choices of multiple-choice questions only", () => {
    const c = ctx({ questions: [q("a", "A"), q("b", "B", ["x"], 0, "short_answer"), q("c", "C")] });
    const [ask, yes] = talk(["shuffle the choices", "yes"], c);
    expect(ask!.state).toMatchObject({
      kind: "confirm",
      effect: { type: "shuffle_choices", questionIds: ["a", "c"] },
    });
    expect(yes!.run).toMatchObject({ type: "shuffle_choices", questionIds: ["a", "c"] });
  });

  it("explains when there is nothing to shuffle", () => {
    const c = ctx({ questions: [q("b", "B", ["x"], 0, "short_answer")] });
    expect(text(step(START, "shuffle the choices", c))).toContain("no multiple-choice");
  });

  it("reports how many choice shuffles worked", () => {
    const effect: Effect = { type: "shuffle_choices", questionIds: ["a", "b", "c"] };
    expect(text(afterEffect(effect, { ok: true, data: { done: 3, failed: 0 } }, ctx()))).toBe(
      "Shuffled the choices of 3 questions.",
    );
    expect(text(afterEffect(effect, { ok: true, data: { done: 2, failed: 1 } }, ctx()))).toContain(
      "could not shuffle 1",
    );
  });
});

describe("add a question", () => {
  it("walks through text, choices, and the correct answer, then confirms", () => {
    const results = talk(["add a question", "What is 2 + 2?", "3\n4\n5", "2", "yes"]);
    expect(results.map((r) => r.state.kind)).toEqual([
      "add_text",
      "add_options",
      "add_correct",
      "confirm",
      "none",
    ]);
    expect(results[3]!.state).toMatchObject({
      effect: {
        type: "add_question",
        prompt: "What is 2 + 2?",
        options: ["3", "4", "5"],
        correctIndex: 1,
      },
    });
    expect(last(results).run).toMatchObject({ type: "add_question", correctIndex: 1 });
  });

  it("skips the first question when the text came with the command", () => {
    const results = talk(["add a question: what is a set?", "a | b", "b"]);
    expect(results[0]!.state).toEqual({ kind: "add_options", text: "what is a set?" });
    expect(results[2]!.state).toMatchObject({
      kind: "confirm",
      effect: { type: "add_question", correctIndex: 1 },
    });
  });

  it("accepts the correct answer by its text", () => {
    const results = talk(["add a question: q", "red | green", "green"]);
    expect(results[2]!.state).toMatchObject({ effect: { correctIndex: 1 } });
  });

  it("re-asks for too few, too many, or duplicate choices", () => {
    const [, one, tooMany, dupes] = talk([
      "add a question: q",
      "only one",
      Array.from({ length: 11 }, (_, i) => `opt${i}`).join("|"),
      "same | Same",
    ]);
    for (const r of [one!, tooMany!, dupes!]) expect(r.state.kind).toBe("add_options");
    expect(text(one!)).toContain("between 2 and 10");
    expect(text(tooMany!)).toContain("between 2 and 10");
    expect(text(dupes!)).toContain("different");
  });

  it("re-asks when the correct answer cannot be matched", () => {
    const results = talk(["add a question: q", "a | b", "purple"]);
    expect(results[2]!.state.kind).toBe("add_correct");
    expect(text(results[2]!)).toContain("could not match");
  });
});

describe("remove a question", () => {
  it("confirms before removing, naming the question", () => {
    const [ask, yes] = talk(["remove question 2", "yes"]);
    expect(ask!.state).toMatchObject({
      kind: "confirm",
      effect: { type: "delete_question", questionId: "q2" },
    });
    expect(text(ask!)).toContain('question 2 ("What is a tuple?")');
    expect(yes!.run).toMatchObject({ type: "delete_question", questionId: "q2" });
  });

  it("supports first, last, and quoted text", () => {
    expect(
      (talk(["delete the first question"])[0]!.state as { effect: { questionId: string } }).effect
        .questionId,
    ).toBe("q1");
    expect(
      (talk(["delete the last question"])[0]!.state as { effect: { questionId: string } }).effect
        .questionId,
    ).toBe("q3");
    expect(
      (
        talk(['remove the question "What is a dict?"'])[0]!.state as {
          effect: { questionId: string };
        }
      ).effect.questionId,
    ).toBe("q3");
  });

  it("never acts on a question number that does not exist", () => {
    const [r] = talk(["remove question 9"]);
    expect(r!.state.kind).toBe("ask_target");
    expect(r!.run).toBeUndefined();
    expect(text(r!)).toContain("There is no question 9; this set has 3 questions");
  });

  it("asks which question when none was named, then resolves the answer", () => {
    const results = talk(["remove a question", "3", "yes"]);
    expect(results[0]!.state.kind).toBe("ask_target");
    expect(results[1]!.state).toMatchObject({ effect: { questionId: "q3" } });
    expect(last(results).run).toMatchObject({ type: "delete_question", questionId: "q3" });
  });

  it("lists the candidates when several match, and only accepts one of them", () => {
    const [ask, wrong, right] = talk(['remove the question "What is a"', "9", "2"]);
    expect(ask!.state).toMatchObject({ kind: "ask_target", candidates: [0, 1, 2] });
    expect(text(ask!)).toContain("More than one question matches");
    expect(wrong!.state.kind).toBe("ask_target");
    expect(wrong!.run).toBeUndefined();
    expect(right!.state).toMatchObject({ kind: "confirm", effect: { questionId: "q2" } });
  });

  it("says so when the set has no questions", () => {
    expect(text(step(START, "remove question 1", ctx({ questions: [] })))).toBe(
      "This set has no questions yet.",
    );
  });

  it("offers to exclude instead when the server says the question has history", () => {
    const effect = {
      type: "delete_question",
      questionId: "q2",
      label: 'question 2 ("What is a tuple?")',
    } as const;
    const failed = afterEffect(
      effect,
      { ok: false, code: "has_history", message: "has study history" },
      ctx(),
    );
    expect(failed.state).toMatchObject({
      kind: "confirm",
      effect: { type: "exclude_question", questionId: "q2" },
    });
    expect(text(failed)).toContain("cannot be deleted");
    const confirmed = step(failed.state, "yes", ctx());
    expect(confirmed.run).toMatchObject({ type: "exclude_question", questionId: "q2" });
  });

  it("reports other failures plainly", () => {
    const effect: Effect = { type: "delete_question", questionId: "q2", label: "question 2" };
    expect(
      text(afterEffect(effect, { ok: false, code: "network", message: "offline" }, ctx())),
    ).toBe("That did not work: offline");
  });
});

describe("update a question", () => {
  it("applies changes given in the command after confirming", () => {
    const [ask, yes] = talk(['update question 1 text to "What is a set?"', "yes"]);
    expect(ask!.state).toMatchObject({
      kind: "confirm",
      effect: { type: "update_question", questionId: "q1", patch: { prompt: "What is a set?" } },
    });
    expect(yes!.run).toMatchObject({ type: "update_question", questionId: "q1" });
  });

  it("keeps the answer when the new choices still contain it", () => {
    const results = talk(["update question 1", "skip", "red | yellow | pink"]);
    expect(results[2]!.state).toMatchObject({
      kind: "confirm",
      effect: {
        patch: {
          options: [
            { id: "a", text: "red" },
            { id: "b", text: "yellow" },
            { id: "c", text: "pink" },
          ],
          correctOptionIds: ["a"],
        },
      },
    });
  });

  it("asks which choice is correct when the old answer is gone", () => {
    const results = talk(["update question 1", "New text?", "one | two | three", "two", "yes"]);
    expect(results.map((r) => r.state.kind)).toEqual([
      "update_text",
      "update_options",
      "update_correct",
      "confirm",
      "none",
    ]);
    expect(results[3]!.state).toMatchObject({
      effect: { patch: { prompt: "New text?", correctOptionIds: ["b"] } },
    });
  });

  it("changes only the correct answer by number or text", () => {
    const results = talk(["update question 1", "skip", "skip", "green"]);
    expect(results[3]!.state).toMatchObject({
      effect: { patch: { correctOptionIds: ["q1-1"] } },
    });
    expect(
      (results[3]!.state as { effect: { patch: { options?: unknown } } }).effect.patch.options,
    ).toBeUndefined();
  });

  it("re-asks for invalid choices and unmatched answers without changing anything", () => {
    const [, , badOptions] = talk(["update question 1", "skip", "only one"]);
    expect(badOptions!.state.kind).toBe("update_options");
    expect(badOptions!.run).toBeUndefined();
    const [, , , , badCorrect] = talk(
      ["update question 1", "skip", "a | b", "purple"].concat("purple"),
    );
    expect(badCorrect!.run).toBeUndefined();
    expect(badCorrect!.state.kind).toBe("update_correct");
  });

  it("changes nothing when every step is skipped", () => {
    const results = talk(["update question 1", "skip", "skip", "skip"]);
    expect(last(results).run).toBeUndefined();
    expect(text(last(results))).toContain("Nothing to change");
    expect(last(results).state).toEqual(START);
  });

  it("explains that only multiple-choice questions can be changed here", () => {
    const c = ctx({ questions: [q("q1", "Type it", ["x"], 0, "short_answer")] });
    const result = step(START, "update question 1", c);
    expect(result.state).toEqual(START);
    expect(text(result)).toContain("not a multiple-choice question");
  });

  it("says when an edited question still needs the owner's approval", () => {
    const c = ctx({ questions: [{ ...q("q1", "From a sample"), needsReview: true }] });
    expect(text(step(START, 'update question 1 text to "Better"', c))).toContain(
      "still needs your approval",
    );
    expect(text(step(START, 'update question 1 text to "Better"', ctx()))).not.toContain(
      "approval",
    );
  });

  describe("multiple-answer questions", () => {
    const multi = (correct: number[]) => ({
      ...q("m1", "Pick all primes", ["2", "3", "4", "5"], 0, "mcq_multi"),
      options: ["2", "3", "4", "5"].map((t, i) => ({
        id: `m1-${i}`,
        text: t,
        correct: correct.includes(i),
      })),
    });
    const withMulti = (correct = [0, 1, 3]) => ctx({ questions: [multi(correct)] });

    it("keeps every correct answer when a distractor is replaced", () => {
      const results = talk(["update question 1", "skip", "2 | 3 | 6 | 5"], withMulti());
      expect(results[2]!.state).toMatchObject({
        kind: "confirm",
        effect: {
          type: "update_question",
          patch: {
            options: [
              { id: "a", text: "2" },
              { id: "b", text: "3" },
              { id: "c", text: "6" },
              { id: "d", text: "5" },
            ],
            correctOptionIds: ["a", "b", "d"],
          },
        },
      });
      expect(text(results[2]!)).not.toContain("only the option");
    });

    it("keeps all correct answers when only the options are reordered or one is added", () => {
      const result = step(START, "update question 1 options: 5 | 4 | 3 | 2 | 7", withMulti());
      const effect = (result.state as Extract<Pending, { kind: "confirm" }>).effect as Extract<
        Effect,
        { type: "update_question" }
      >;
      // 2, 3 and 5 stay correct, wherever they moved to in the new list.
      expect([...effect.patch.correctOptionIds!].sort()).toEqual(["a", "c", "d"]);
    });

    it("previews every kept correct answer", () => {
      const result = step(START, "update question 1 options: 2 | 3 | 6 | 5", withMulti());
      const preview = (result.state as Extract<Pending, { kind: "confirm" }>).preview;
      expect(preview.filter((line) => line.includes("[correct]"))).toHaveLength(3);
    });

    it("refuses to guess when a correct answer is removed", () => {
      const result = step(START, "update question 1 options: 2 | 3 | 4 | 9", withMulti());
      expect(result.state).toEqual(START);
      expect(result.run).toBeUndefined();
      expect(text(result)).toContain("more than one correct answer");
      expect(text(result)).toContain("Edit button");
    });

    it("sends changing the correct answers to the Edit form instead of dropping the rest", () => {
      const result = step(START, "update question 1 correct answer is 2", withMulti());
      expect(result.state).toEqual(START);
      expect(result.run).toBeUndefined();
      expect(text(result)).toContain("more than one correct answer");
    });

    it("still allows changing only the text", () => {
      const result = step(START, 'update question 1 text to "Pick every prime"', withMulti());
      expect(result.state).toMatchObject({
        kind: "confirm",
        effect: { patch: { prompt: "Pick every prime" } },
      });
      expect(
        (result.state as { effect: { patch: { correctOptionIds?: unknown } } }).effect.patch
          .correctOptionIds,
      ).toBeUndefined();
    });

    it("does not ask which option is correct in the step-by-step flow", () => {
      const results = talk(["update question 1", "skip", "skip"], withMulti());
      expect(results[2]!.state.kind).toBe("none");
      expect(text(results[2]!)).toContain("Nothing to change");
    });
  });

  it("asks for the answer again for a single-answer question whose correct choice is gone", () => {
    const result = step(START, "update question 1 options: x | y | z", ctx());
    expect(result.state.kind).toBe("update_correct");
  });

  it("never updates an unresolved target", () => {
    const [r] = talk(["update the question about zebras"]);
    expect(r!.state.kind).toBe("ask_target");
    expect(r!.run).toBeUndefined();
  });
});

describe("rewrite a question", () => {
  it("explains that AI rewriting is not available yet", () => {
    const result = step(START, "rephrase question 2", ctx({ aiEnabled: true }));
    expect(result.run).toBeUndefined();
    expect(result.state).toEqual(START);
    expect(text(result)).toContain("not available yet");
  });
});

describe("generate questions", () => {
  it("explains that it needs AI when AI is off", () => {
    const result = step(START, "generate 5 questions about loops", ctx());
    expect(result.run).toBeUndefined();
    expect(text(result)).toContain("needs AI");
  });

  it("runs straight away when count and topic are given", () => {
    const result = step(START, "generate 5 questions about loops", ctx({ aiEnabled: true }));
    expect(result.run).toEqual({ type: "generate", count: 5, topic: "loops" });
  });

  it("asks for what is missing and merges the answer", () => {
    const c = ctx({ aiEnabled: true });
    const results = talk(["generate some questions", "4 on recursion"], c);
    expect(results[0]!.state.kind).toBe("ask_generate");
    expect(last(results).run).toEqual({ type: "generate", count: 4, topic: "recursion" });
  });

  it("rejects counts outside 1-10", () => {
    const result = step(START, "generate 50 questions about loops", ctx({ aiEnabled: true }));
    expect(result.run).toBeUndefined();
    expect(text(result)).toContain("1 to 10");
  });

  it("describes the outcome", () => {
    const effect: Effect = { type: "generate", count: 5, topic: "loops" };
    expect(
      text(afterEffect(effect, { ok: true, data: { proposed: 4, dropped: 1 } }, ctx())),
    ).toContain("1 failed checks");
    expect(
      text(afterEffect(effect, { ok: true, data: { proposed: 0, dropped: 0 } }, ctx())),
    ).toContain("No usable questions");
    expect(
      text(
        afterEffect(
          effect,
          { ok: false, code: "ai_unavailable", message: "AI help is not available right now." },
          ctx(),
        ),
      ),
    ).toContain("not available right now");
  });
});

describe("cancel, confirm, and ordinary messages", () => {
  it.each(["cancel", "no", "stop", "never mind"])("%s abandons a pending change", (word) => {
    const [ask, cancelled] = talk(["remove question 1", word]);
    expect(ask!.state.kind).toBe("confirm");
    expect(cancelled!.state).toEqual(START);
    expect(cancelled!.run).toBeUndefined();
    expect(text(cancelled!)).toContain("left everything as it was");
  });

  it("cancels in the middle of a question the assistant asked", () => {
    const [, cancelled] = talk(["add a question", "cancel"]);
    expect(cancelled!.state).toEqual(START);
  });

  it("does not confirm on unrelated text; it asks again", () => {
    const [, other] = talk(["remove question 1", "hmm what about lunch"]);
    expect(other!.run).toBeUndefined();
    expect(other!.state.kind).toBe("confirm");
    expect(text(other!)).toContain("confirm");
  });

  it("replaces a pending preview with a new command instead of confirming it", () => {
    const [, replaced] = talk(["remove question 1", "rename this set to Other"]);
    expect(replaced!.run).toBeUndefined();
    expect(replaced!.state).toMatchObject({
      kind: "confirm",
      effect: { type: "rename_set", title: "Other" },
    });
    expect(text(replaced!)).toContain("dropped the previous change");
  });

  it("passes ordinary messages to the AI only when it is on", () => {
    expect(step(START, "what is recursion?", ctx({ aiEnabled: true })).passToAi).toBe(true);
    const off = step(START, "what is recursion?", ctx());
    expect(off.passToAi).toBeUndefined();
    expect(text(off)).toBe(helpMessage(false));
  });

  it("ignores empty input", () => {
    const result = step(START, "   ", ctx());
    expect(result.messages).toEqual([]);
    expect(result.run).toBeUndefined();
  });

  it("describes what each successful action did", () => {
    const c = ctx();
    expect(text(afterEffect({ type: "rename_set", title: "X" }, { ok: true }, c))).toContain(
      'Renamed the set to "X"',
    );
    expect(text(afterEffect({ type: "create_set", title: "X" }, { ok: true }, c))).toContain(
      "Created",
    );
    expect(text(afterEffect({ type: "reorder", questionIds: [] }, { ok: true }, c))).toContain(
      "new order",
    );
    expect(
      text(
        afterEffect(
          { type: "add_question", prompt: "p", options: [], correctIndex: 0 },
          { ok: true },
          c,
        ),
      ),
    ).toContain("Added");
    expect(
      text(
        afterEffect(
          { type: "exclude_question", questionId: "q", label: "question 1" },
          { ok: true },
          c,
        ),
      ),
    ).toContain("history is kept");
  });
});
