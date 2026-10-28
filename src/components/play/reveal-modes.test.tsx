// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnswerResult, PlayItem, PlayQuestion, PlaySession } from "@/lib/client/types";
import { PlayScreen } from "./PlayScreen";
import { describeCorrect, describeResponse } from "./review";
import { initialState, playReducer, summarize } from "./state";
import { result, session } from "./test-helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

let calls: { url: string; method: string; body: unknown }[];
let answerBody: unknown;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(answerBody), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const hidden = (over: Partial<AnswerResult> = {}): AnswerResult => ({
  attemptId: "a",
  pass: 1,
  disclosure: "none",
  response: { kind: "options", selectedOptionIds: ["a"] },
  submittedAt: "2026-01-01T00:00:00Z",
  ...over,
});

async function answerFirstQuestion(play: PlaySession) {
  const user = userEvent.setup();
  render(<PlayScreen initial={play} setTitle="Week 1" />);
  await user.click(screen.getByLabelText("A"));
  await user.click(screen.getByRole("button", { name: "Submit answer" }));
  return user;
}

describe("end mode", () => {
  it("says the answer was saved and shows no verdict, answer, or explanation", async () => {
    answerBody = {
      result: hidden(),
      requeued: false,
      progress: { answered: 1, total: 2 },
    };
    await answerFirstQuestion(session({ revealMode: "end" }));
    expect(await screen.findByText("Answer saved")).toBeInTheDocument();
    expect(screen.getByText(/how you did when you finish/i)).toBeInTheDocument();
    expect(screen.queryByText(/not quite|correct answer|✓|✗/i)).not.toBeInTheDocument();
    expect(screen.getByText("Results at the end")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
  });
});

describe("requeue mode", () => {
  it("shows the verdict without the answer and says the question comes back", async () => {
    answerBody = {
      result: hidden({ disclosure: "verdict", outcome: "incorrect", isCorrect: false }),
      requeued: true,
      progress: { answered: 1, total: 3 },
    };
    await answerFirstQuestion(session({ revealMode: "requeue" }));
    expect(await screen.findByText(/Not quite/)).toBeInTheDocument();
    expect(screen.getByText(/see this question again at the end/i)).toBeInTheDocument();
    // No answer is shown: no highlighted option and no accepted-answer text.
    expect(screen.queryByText(/— correct answer/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Accepted answer/)).not.toBeInTheDocument();
    // The server's new total (one retry added) is used for progress.
    expect(screen.getByText(/1 of 3 answered \(includes 1 retry\)/)).toBeInTheDocument();
  });

  it("labels the retry as a second try", () => {
    const play = session({
      revealMode: "requeue",
      progress: { total: 3, answered: 2, removed: 0, retries: 1 },
      current: { ...session().current!, pass: 2 },
    });
    render(<PlayScreen initial={play} setTitle="Week 1" />);
    expect(screen.getByText(/Second try/)).toBeInTheDocument();
    expect(screen.getByText("Wrong answers retried once")).toBeInTheDocument();
  });
});

describe("each mode", () => {
  it("shows no mode badge and no second-try notice", () => {
    render(<PlayScreen initial={session()} setTitle="Week 1" />);
    expect(screen.queryByText("Results at the end")).not.toBeInTheDocument();
    expect(screen.queryByText(/Second try/)).not.toBeInTheDocument();
  });
});

const asked = (id: string, prompt: string): PlayQuestion => ({
  questionId: id,
  revisionNumber: 1,
  type: "mcq_single",
  prompt,
  codeSnippet: null,
  options: [
    { id: "a", text: "Alpha" },
    { id: "b", text: "Beta" },
  ],
});

const finished = (revealMode: "end" | "requeue"): PlaySession => {
  const items: PlayItem[] = [
    {
      questionId: "q1",
      position: 0,
      pass: 1,
      status: "answered",
      question: asked("q1", "First question?"),
      result: {
        ...result("incorrect"),
        explanation: "Because beta.",
        correctAnswer: { kind: "options", correctOptionIds: ["b"] },
      },
    },
    {
      questionId: "q2",
      position: 1,
      pass: 1,
      status: "answered",
      question: asked("q2", "Second question?"),
      result: { ...result("correct"), correctAnswer: { kind: "options", correctOptionIds: ["a"] } },
    },
    ...(revealMode === "requeue"
      ? [
          {
            questionId: "q1",
            position: 2,
            pass: 2 as const,
            status: "answered" as const,
            question: asked("q1", "First question?"),
            result: {
              ...result("correct"),
              pass: 2 as const,
              response: { kind: "options" as const, selectedOptionIds: ["b"] },
            },
          },
        ]
      : []),
  ];
  return session({
    state: "completed",
    revealMode,
    progress: {
      total: items.length,
      answered: items.length,
      removed: 0,
      retries: items.length - 2,
    },
    items,
    current: null,
  });
};

describe("results", () => {
  it("reviews every answer with the correct answer once an end-mode session is over", () => {
    render(<PlayScreen initial={finished("end")} setTitle="Week 1" />);
    expect(screen.getByText("Session complete")).toBeInTheDocument();
    expect(screen.getByText(/1 correct out of 2 answered/)).toBeInTheDocument();
    const review = screen.getByRole("list", { name: "Answers" });
    const first = within(review).getAllByRole("listitem")[0]!;
    expect(first).toHaveTextContent("First question?");
    expect(first).toHaveTextContent("Your answer: Alpha");
    expect(first).toHaveTextContent("Correct answer: Beta");
    expect(first).toHaveTextContent("Because beta.");
  });

  it("reports first tries and second tries separately, with the retry in the review", () => {
    render(<PlayScreen initial={finished("requeue")} setTitle="Week 1" />);
    expect(screen.getByText(/First try: 1 correct out of 2 answered/)).toBeInTheDocument();
    expect(screen.getByText(/Second tries: 1 correct out of 1/)).toBeInTheDocument();
    const first = within(screen.getByRole("list", { name: "Answers" })).getAllByRole(
      "listitem",
    )[0]!;
    expect(first).toHaveTextContent("Second try: Beta");
  });

  it("has no review for a session that showed feedback after every answer", () => {
    render(<PlayScreen initial={{ ...finished("end"), revealMode: "each" }} setTitle="Week 1" />);
    expect(screen.queryByRole("heading", { name: "Review your answers" })).not.toBeInTheDocument();
  });
});

describe("summarize", () => {
  it("counts first tries and retries apart and counts questions once", () => {
    const summary = summarize(finished("requeue"));
    expect(summary).toMatchObject({
      totalItems: 2,
      answered: 2,
      correct: 1,
      incorrect: 1,
      unanswered: 0,
      retry: { total: 1, answered: 1, correct: 1, incorrect: 0 },
      revealMode: "requeue",
    });
  });
});

describe("reducer", () => {
  it("takes the server's progress and adds a retry when the answer was requeued", () => {
    const start = initialState(session({ revealMode: "requeue" }));
    const submitting = playReducer(start, { type: "submit_start", key: "key-12345678" });
    const next = playReducer(submitting, {
      type: "submit_ok",
      result: hidden({ disclosure: "verdict", outcome: "incorrect", isCorrect: false }),
      progress: { answered: 1, total: 3 },
      requeued: true,
    });
    expect(next.session.progress).toEqual({ total: 3, answered: 1, removed: 0, retries: 1 });
    expect(next.phase).toBe("feedback");
  });
});

describe("review wording", () => {
  const q = asked("q", "Which?");
  it("describes responses in words", () => {
    expect(describeResponse(q, { kind: "options", selectedOptionIds: ["a", "b"] })).toBe(
      "Alpha; Beta",
    );
    expect(describeResponse(q, { kind: "text", text: "hello" })).toBe("hello");
    expect(describeResponse(q, { kind: "blanks", values: ["x", "y"] })).toBe("x | y");
    expect(describeResponse(q, { kind: "options", selectedOptionIds: [] })).toBe(
      "(nothing chosen)",
    );
  });

  it("describes correct answers in words", () => {
    expect(describeCorrect(q, { kind: "options", correctOptionIds: ["b"] })).toBe("Beta");
    expect(describeCorrect(q, { kind: "text", accepted: ["a", "b"] })).toBe("a or b");
    expect(describeCorrect(q, { kind: "blanks", blanks: [["1", "one"], ["2"]] })).toBe(
      "1 or one | 2",
    );
    expect(describeCorrect(q, { kind: "unresolved" })).toMatch(/No correct answer/);
  });
});
