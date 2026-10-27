import { describe, expect, it } from "vitest";
import { currentResponse, initialState, playReducer, summarize } from "./state";
import { result, session } from "./test-helpers";

describe("playReducer", () => {
  it("selects one option for single choice and toggles for multiple choice", () => {
    let state = initialState(session());
    state = playReducer(state, { type: "select", optionId: "a", multiple: false });
    state = playReducer(state, { type: "select", optionId: "b", multiple: false });
    expect(state.selected).toEqual(["b"]);

    state = playReducer(state, { type: "select", optionId: "a", multiple: true });
    expect(state.selected).toEqual(["b", "a"]);
    state = playReducer(state, { type: "select", optionId: "b", multiple: true });
    expect(state.selected).toEqual(["a"]);
  });

  it("moves answering -> submitting -> feedback and counts the answer once", () => {
    let state = initialState(session());
    state = playReducer(state, { type: "select", optionId: "b", multiple: false });
    state = playReducer(state, { type: "submit_start", key: "key-1" });
    expect(state.phase).toBe("submitting");
    state = playReducer(state, {
      type: "submit_ok",
      result: result("correct"),
      progress: { answered: 1, total: 2 },
      requeued: false,
    });
    expect(state.phase).toBe("feedback");
    expect(state.feedback?.outcome).toBe("correct");
    expect(state.session.progress.answered).toBe(1);
  });

  it("locks the answer while submitting and after feedback", () => {
    let state = initialState(session());
    state = playReducer(state, { type: "select", optionId: "a", multiple: false });
    state = playReducer(state, { type: "submit_start", key: "key-1" });
    const locked = playReducer(state, { type: "select", optionId: "b", multiple: false });
    expect(locked.selected).toEqual(["a"]);
  });

  it("keeps the same idempotency key across a failed submit and a retry", () => {
    let state = initialState(session());
    state = playReducer(state, { type: "select", optionId: "a", multiple: false });
    state = playReducer(state, { type: "submit_start", key: "first-key" });
    state = playReducer(state, { type: "submit_fail", error: "offline" });
    expect(state.phase).toBe("answering");
    expect(state.error).toBe("offline");
    expect(state.idempotencyKey).toBe("first-key");

    state = playReducer(state, { type: "submit_start", key: "a-different-key" });
    expect(state.idempotencyKey).toBe("first-key");
  });

  it("starts the next question fresh when the session is replaced", () => {
    let state = initialState(session());
    state = playReducer(state, { type: "select", optionId: "a", multiple: false });
    state = playReducer(state, { type: "submit_start", key: "k" });
    state = playReducer(state, {
      type: "submit_ok",
      result: result("incorrect"),
      progress: { answered: 1, total: 2 },
      requeued: false,
    });
    state = playReducer(state, {
      type: "session",
      session: session({
        progress: { total: 2, answered: 1, removed: 0, retries: 0 },
        current: { ...session().current!, questionId: "q2", prompt: "Second" },
      }),
    });
    expect(state).toMatchObject({
      phase: "answering",
      selected: [],
      idempotencyKey: null,
      feedback: null,
    });
    expect(state.session.current?.prompt).toBe("Second");
  });

  it("builds one blank per blankCount for fill-in questions", () => {
    const fill = session({
      current: {
        questionId: "q1",
        revisionNumber: 1,
        type: "fill_blank",
        prompt: "x = __, y = __",
        codeSnippet: null,
        options: [],
        blankCount: 2,
      },
    });
    let state = initialState(fill);
    expect(state.blanks).toEqual(["", ""]);
    expect(currentResponse(state)).toBeNull();
    state = playReducer(state, { type: "blank", index: 0, value: "1" });
    expect(currentResponse(state)).toBeNull();
    state = playReducer(state, { type: "blank", index: 1, value: "2" });
    expect(currentResponse(state)).toEqual({ kind: "blanks", values: ["1", "2"] });
  });

  it("shows the summary after completing", () => {
    const done = session({ state: "completed", current: null, elapsedSeconds: 75 });
    const state = playReducer(initialState(session()), {
      type: "complete_ok",
      session: done,
      summary: summarize(done),
    });
    expect(state.summary).toMatchObject({ totalItems: 2, unanswered: 2, elapsedSeconds: 75 });
  });
});

describe("summarize", () => {
  it("counts outcomes from the results already returned for answered items", () => {
    const s = session({
      state: "completed",
      current: null,
      progress: { total: 3, answered: 3, removed: 0, retries: 0 },
      items: [
        { questionId: "q1", position: 0, pass: 1, status: "answered", result: result("correct") },
        { questionId: "q2", position: 1, pass: 1, status: "answered", result: result("incorrect") },
        { questionId: "q3", position: 2, pass: 1, status: "answered", result: result("uncertain") },
      ],
    });
    expect(summarize(s)).toMatchObject({ correct: 1, incorrect: 1, uncertain: 1, unanswered: 0 });
  });
});
