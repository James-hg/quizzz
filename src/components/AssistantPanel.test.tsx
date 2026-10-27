// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerQuestionView } from "@/lib/client/types";
import { AssistantPanel } from "./AssistantPanel";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];

type Reply = { status?: number; body?: unknown };
/** Replaces fetch. Routes are "METHOD /path"; anything unlisted fails the test. */
function stubApi(routes: Record<string, Reply | Reply[]> = {}) {
  calls = [];
  const counters = new Map<string, number>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const key = `${method} ${url}`;
      const entry = routes[key];
      if (!entry) throw new Error(`Unexpected request: ${key}`);
      const index = counters.get(key) ?? 0;
      counters.set(key, index + 1);
      const reply = Array.isArray(entry) ? entry[Math.min(index, entry.length - 1)]! : entry;
      const status = reply.status ?? 200;
      if (status === 204) return new Response(null, { status });
      return new Response(JSON.stringify(reply.body ?? {}), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  calls = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function question(
  id: string,
  prompt: string,
  over: Partial<OwnerQuestionView> = {},
): OwnerQuestionView {
  return {
    id,
    questionSetId: "set1",
    position: 0,
    status: "active",
    revisionId: `r-${id}`,
    revisionNumber: 1,
    type: "mcq_single",
    prompt,
    codeSnippet: null,
    options: [
      { id: "a", text: "red" },
      { id: "b", text: "green" },
      { id: "c", text: "blue" },
    ],
    answerKey: { kind: "options", correctOptionIds: ["a"] },
    explanation: null,
    origin: "original",
    evidenceStatus: "human_reviewed",
    ...over,
  } as OwnerQuestionView;
}

const QUESTIONS = [
  question("q1", "What is a list?"),
  question("q2", "What is a tuple?"),
  question("q3", "What is a dict?"),
];

function setup(props: { enabled?: boolean; questions?: OwnerQuestionView[] } = {}) {
  const user = userEvent.setup();
  render(
    <AssistantPanel
      enabled={props.enabled ?? false}
      questionSetId="set1"
      courseId="course1"
      setTitle="Week 1"
      questions={props.questions ?? QUESTIONS}
    />,
  );
  return user;
}

async function send(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByLabelText(/Your (message|command)/), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
}
const confirm = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Confirm" }));
const conversation = () => screen.getByRole("list", { name: "Conversation" });
const awaiting = () =>
  screen.queryByRole("group", { name: "Change waiting for your confirmation" });

describe("with AI turned off", () => {
  it("still offers the command box, and says AI is off", () => {
    setup();
    expect(screen.getByLabelText("Your command")).toBeInTheDocument();
    expect(screen.getByText(/AI help is turned off on this server\. Practice/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Propose questions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Suggest a title" })).not.toBeInTheDocument();
  });

  it("lists what it understands instead of calling AI for other messages", async () => {
    stubApi();
    const user = setup();
    await send(user, "what is recursion?");
    expect(conversation()).toHaveTextContent("AI help is off, so I only understand these commands");
    expect(calls).toEqual([]);
  });

  it("explains that generating questions needs AI", async () => {
    stubApi();
    const user = setup();
    await send(user, "generate 5 questions about loops");
    expect(conversation()).toHaveTextContent("needs AI, which is turned off");
    expect(calls).toEqual([]);
  });
});

describe("rename", () => {
  it("shows a preview, waits for confirmation, then renames and refreshes", async () => {
    stubApi({ "PATCH /api/question-sets/set1": {} });
    const user = setup();
    await send(user, "rename this set to Week 2");
    expect(awaiting()).toHaveTextContent("New name: Week 2");
    expect(calls).toEqual([]);
    await confirm(user);
    expect(calls).toEqual([
      { method: "PATCH", url: "/api/question-sets/set1", body: { title: "Week 2" } },
    ]);
    expect(conversation()).toHaveTextContent('Renamed the set to "Week 2"');
    expect(awaiting()).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("accepts a typed yes instead of the button", async () => {
    stubApi({ "PATCH /api/question-sets/set1": {} });
    const user = setup();
    await send(user, "rename this set to Week 2");
    await send(user, "yes");
    expect(calls).toHaveLength(1);
  });

  it("uses the AI's suggested title when no name is given and AI is on", async () => {
    stubApi({
      "POST /api/ai/question-sets/set1/suggest-title": { body: { title: "Python basics" } },
      "PATCH /api/question-sets/set1": {},
    });
    const user = setup({ enabled: true });
    await send(user, "rename this set");
    expect(
      await screen.findByRole("group", { name: /waiting for your confirmation/ }),
    ).toHaveTextContent("Python basics");
    await confirm(user);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/ai/question-sets/set1/suggest-title",
      "PATCH /api/question-sets/set1",
    ]);
    expect(calls[1]!.body).toEqual({ title: "Python basics" });
  });

  it("asks for a name when AI is off", async () => {
    stubApi({ "PATCH /api/question-sets/set1": {} });
    const user = setup();
    await send(user, "rename this quiz");
    expect(conversation()).toHaveTextContent("What should this set be called?");
    await send(user, "Loops");
    await confirm(user);
    expect(calls[0]!.body).toEqual({ title: "Loops" });
  });
});

describe("cancel", () => {
  it("sends nothing when the user cancels", async () => {
    stubApi();
    const user = setup();
    await send(user, "remove question 1");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls).toEqual([]);
    expect(conversation()).toHaveTextContent("left everything as it was");
    expect(awaiting()).toBeNull();
  });
});

describe("shuffle", () => {
  it("reorders the questions after confirmation", async () => {
    stubApi({ "PUT /api/question-sets/set1/questions/order": {} });
    const user = setup();
    await send(user, "shuffle the questions");
    expect(calls).toEqual([]);
    await confirm(user);
    const order = (calls[0]!.body as { questionIds: string[] }).questionIds;
    expect([...order].sort()).toEqual(["q1", "q2", "q3"]);
    expect(order).not.toEqual(["q1", "q2", "q3"]);
    expect(refresh).toHaveBeenCalled();
  });

  it("explains when there are not enough questions", async () => {
    stubApi();
    const user = setup({ questions: [QUESTIONS[0]!] });
    await send(user, "shuffle the questions");
    expect(conversation()).toHaveTextContent("at least two questions");
    expect(calls).toEqual([]);
  });

  it("shuffles each multiple-choice question's choices and skips other types", async () => {
    stubApi({
      "POST /api/questions/q1/shuffle-options": {},
      "POST /api/questions/q3/shuffle-options": {},
    });
    const user = setup({
      questions: [
        QUESTIONS[0]!,
        question("q2", "Type it", { type: "short_answer" }),
        QUESTIONS[2]!,
      ],
    });
    await send(user, "shuffle the choices");
    expect(awaiting()).toHaveTextContent("2 multiple-choice questions");
    await confirm(user);
    expect(calls.map((c) => c.url)).toEqual([
      "/api/questions/q1/shuffle-options",
      "/api/questions/q3/shuffle-options",
    ]);
    expect(conversation()).toHaveTextContent("Shuffled the choices of 2 questions");
  });

  it("reports a partial failure honestly", async () => {
    stubApi({
      "POST /api/questions/q1/shuffle-options": {},
      "POST /api/questions/q2/shuffle-options": {
        status: 500,
        body: { error: { code: "x", message: "boom" } },
      },
      "POST /api/questions/q3/shuffle-options": {},
    });
    const user = setup();
    await send(user, "shuffle the choices");
    await confirm(user);
    expect(conversation()).toHaveTextContent("Shuffled 2 and could not shuffle 1");
  });
});

describe("add a question", () => {
  it("collects the text, choices, and answer, then creates a multiple-choice question", async () => {
    stubApi({ "POST /api/question-sets/set1/questions": { status: 201, body: {} } });
    const user = setup();
    await send(user, "add a question");
    await send(user, "What is 2 + 2?");
    await send(user, "3 | 4 | 5");
    await send(user, "2");
    expect(awaiting()).toHaveTextContent("What is 2 + 2?");
    expect(awaiting()).toHaveTextContent("2. 4 [correct]");
    expect(calls).toEqual([]);
    await confirm(user);
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/api/question-sets/set1/questions",
        body: {
          type: "mcq_single",
          prompt: "What is 2 + 2?",
          options: [
            { id: "a", text: "3" },
            { id: "b", text: "4" },
            { id: "c", text: "5" },
          ],
          correctOptionIds: ["b"],
        },
      },
    ]);
    expect(refresh).toHaveBeenCalled();
  });

  it("keeps asking until the choices and answer are usable", async () => {
    stubApi();
    const user = setup();
    await send(user, "add a question: q?");
    await send(user, "only one");
    expect(conversation()).toHaveTextContent("between 2 and 10");
    await send(user, "x | y");
    await send(user, "purple");
    expect(conversation()).toHaveTextContent("could not match that answer");
    expect(awaiting()).toBeNull();
    expect(calls).toEqual([]);
  });

  it("shows the server's reason when the question is rejected", async () => {
    stubApi({
      "POST /api/question-sets/set1/questions": {
        status: 400,
        body: { error: { code: "validation_error", message: "prompt: too long" } },
      },
    });
    const user = setup();
    await send(user, "add a question: q?");
    await send(user, "x | y");
    await send(user, "1");
    await confirm(user);
    expect(conversation()).toHaveTextContent("That did not work: prompt: too long");
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("remove a question", () => {
  it("asks first, names the question, then deletes it", async () => {
    stubApi({ "DELETE /api/questions/q2": { status: 204 } });
    const user = setup();
    await send(user, "remove question 2");
    expect(conversation()).toHaveTextContent('question 2 ("What is a tuple?")');
    expect(calls).toEqual([]);
    await confirm(user);
    expect(calls).toEqual([{ method: "DELETE", url: "/api/questions/q2", body: undefined }]);
    expect(conversation()).toHaveTextContent("Removed question 2");
  });

  it("offers to exclude a question that has study history, and only then excludes it", async () => {
    stubApi({
      "DELETE /api/questions/q1": {
        status: 409,
        body: {
          error: { code: "has_history", message: "This has study history and cannot be deleted." },
        },
      },
      "POST /api/questions/q1/exclude": {},
    });
    const user = setup();
    await send(user, "remove question 1");
    await confirm(user);
    expect(conversation()).toHaveTextContent("cannot be deleted");
    expect(calls.map((c) => c.method)).toEqual(["DELETE"]);
    expect(awaiting()).toHaveTextContent("question 1");
    await confirm(user);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "DELETE /api/questions/q1",
      "POST /api/questions/q1/exclude",
    ]);
    expect(conversation()).toHaveTextContent("history is kept");
  });

  it("never acts on a question that does not exist", async () => {
    stubApi();
    const user = setup();
    await send(user, "remove question 9");
    expect(conversation()).toHaveTextContent("There is no question 9; this set has 3 questions");
    expect(awaiting()).toBeNull();
    expect(calls).toEqual([]);
  });

  it("asks which question when several match, and acts only on the one chosen", async () => {
    stubApi({ "DELETE /api/questions/q3": { status: 204 } });
    const user = setup();
    await send(user, 'remove the question "What is a"');
    expect(conversation()).toHaveTextContent("More than one question matches");
    expect(awaiting()).toBeNull();
    expect(calls).toEqual([]);
    await send(user, "3");
    await confirm(user);
    expect(calls.map((c) => c.url)).toEqual(["/api/questions/q3"]);
  });

  it("asks which question when none was named", async () => {
    stubApi({ "DELETE /api/questions/q1": { status: 204 } });
    const user = setup();
    await send(user, "delete a question");
    expect(conversation()).toHaveTextContent("could not tell which question");
    await send(user, "first");
    await confirm(user);
    expect(calls[0]!.url).toBe("/api/questions/q1");
  });
});

describe("update a question", () => {
  it("changes only the text given in the command", async () => {
    stubApi({ "PATCH /api/questions/q1": {} });
    const user = setup();
    await send(user, 'update question 1 text to "What is a set?"');
    expect(calls).toEqual([]);
    await confirm(user);
    expect(calls).toEqual([
      { method: "PATCH", url: "/api/questions/q1", body: { prompt: "What is a set?" } },
    ]);
    expect(conversation()).toHaveTextContent("The previous version stays in its history");
  });

  it("walks through text, choices, and the correct answer", async () => {
    stubApi({ "PATCH /api/questions/q2": {} });
    const user = setup();
    await send(user, "update question 2");
    await send(user, "What is a frozenset?");
    await send(user, "one | two | three");
    await send(user, "two");
    await confirm(user);
    expect(calls).toEqual([
      {
        method: "PATCH",
        url: "/api/questions/q2",
        body: {
          prompt: "What is a frozenset?",
          options: [
            { id: "a", text: "one" },
            { id: "b", text: "two" },
            { id: "c", text: "three" },
          ],
          correctOptionIds: ["b"],
        },
      },
    ]);
  });

  it("explains it cannot change a question that is not multiple choice", async () => {
    stubApi();
    const user = setup({ questions: [question("q1", "Type it", { type: "short_answer" })] });
    await send(user, "update question 1");
    expect(conversation()).toHaveTextContent("not a multiple-choice question");
    expect(calls).toEqual([]);
  });

  it("reminds the owner that an unapproved question still needs approval", async () => {
    stubApi();
    const user = setup({
      questions: [
        question("q1", "From a sample", { origin: "sample", evidenceStatus: "needs_review" }),
      ],
    });
    await send(user, 'update question 1 text to "Better"');
    expect(conversation()).toHaveTextContent("still needs your approval");
  });

  it("does nothing on an unmatched target", async () => {
    stubApi();
    const user = setup();
    await send(user, "update the question about zebras");
    expect(awaiting()).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("update a multiple-answer question", () => {
  const multi = question("m1", "Which are small primes?", {
    type: "mcq_multi",
    options: [
      { id: "a", text: "2" },
      { id: "b", text: "3" },
      { id: "c", text: "4" },
    ],
    answerKey: { kind: "options", correctOptionIds: ["a", "b"] },
  });

  it("keeps every correct answer when only a distractor changes", async () => {
    stubApi({ "PATCH /api/questions/m1": {} });
    const user = setup({ questions: [multi] });
    await send(user, "update question 1 options: 2 | 3 | 6");
    expect(awaiting()).toHaveTextContent("1. 2 [correct]");
    expect(awaiting()).toHaveTextContent("2. 3 [correct]");
    await confirm(user);
    expect(calls).toEqual([
      {
        method: "PATCH",
        url: "/api/questions/m1",
        body: {
          options: [
            { id: "a", text: "2" },
            { id: "b", text: "3" },
            { id: "c", text: "6" },
          ],
          correctOptionIds: ["a", "b"],
        },
      },
    ]);
  });

  it("does not drop correct answers when one is removed; it points to the Edit form", async () => {
    stubApi();
    const user = setup({ questions: [multi] });
    await send(user, "update question 1 options: 2 | 5 | 6");
    expect(conversation()).toHaveTextContent("more than one correct answer");
    expect(awaiting()).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("rewrite a question", () => {
  it("explains that AI rewriting is not available yet, even with AI on", async () => {
    stubApi();
    const user = setup({ enabled: true });
    await send(user, "rephrase question 2");
    expect(conversation()).toHaveTextContent("not available yet");
    expect(calls).toEqual([]);
  });
});

describe("create a set", () => {
  it("creates the set in this course and opens it", async () => {
    stubApi({
      "POST /api/courses/course1/question-sets": {
        status: 201,
        body: { questionSet: { id: "new1" } },
      },
    });
    const user = setup();
    await send(user, "create a quiz called Practice");
    expect(awaiting()).toHaveTextContent("New set: Practice");
    expect(calls).toEqual([]);
    await confirm(user);
    expect(calls).toEqual([
      { method: "POST", url: "/api/courses/course1/question-sets", body: { title: "Practice" } },
    ]);
    expect(push).toHaveBeenCalledWith("/question-sets/new1/edit");
  });

  it("asks for a title first when none is given", async () => {
    stubApi({
      "POST /api/courses/course1/question-sets": {
        status: 201,
        body: { questionSet: { id: "n" } },
      },
    });
    const user = setup();
    await send(user, "make a new quiz");
    await send(user, "Exam prep");
    await confirm(user);
    expect(calls[0]!.body).toEqual({ title: "Exam prep" });
  });
});

describe("with AI turned on", () => {
  it("answers other messages with the AI chat and keeps the conversation", async () => {
    stubApi({ "POST /api/ai/chat": { body: { reply: "A list is mutable." } } });
    const user = setup({ enabled: true });
    await send(user, "list vs tuple?");
    expect(await screen.findByText("A list is mutable.")).toBeInTheDocument();
    expect(calls[0]!.body).toMatchObject({
      message: "list vs tuple?",
      questionSetId: "set1",
      courseId: "course1",
      history: [],
    });
    await send(user, "and a dict?");
    await screen.findAllByText(/A list is mutable/);
    expect(calls[1]!.body).toMatchObject({
      history: [
        { role: "user", content: "list vs tuple?" },
        { role: "assistant", content: "A list is mutable." },
      ],
    });
  });

  it("does not send commands to the AI chat", async () => {
    stubApi();
    const user = setup({ enabled: true });
    await send(user, "shuffle the questions");
    expect(calls).toEqual([]);
    expect(awaiting()).not.toBeNull();
  });

  it("shows a clear message when the AI service is unavailable", async () => {
    stubApi({
      "POST /api/ai/chat": {
        status: 503,
        body: { error: { code: "ai_unavailable", message: "AI help is not available right now." } },
      },
    });
    const user = setup({ enabled: true });
    await send(user, "What is a tuple?");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "AI help is not available right now.",
    );
  });

  it("generates proposals from a command and lets the user pick which to save", async () => {
    const proposal = {
      type: "mcq_single",
      prompt: "Proposed one?",
      options: [
        { id: "a", text: "x" },
        { id: "b", text: "y" },
      ],
      correctOptionIds: ["a"],
    };
    stubApi({
      "POST /api/ai/question-sets/set1/generate-questions": {
        body: { proposals: [proposal], dropped: 1 },
      },
      "POST /api/ai/question-sets/set1/save-proposals": { status: 201, body: { questions: [{}] } },
    });
    const user = setup({ enabled: true });
    await send(user, "generate 3 questions about loops");
    expect(calls[0]).toMatchObject({
      url: "/api/ai/question-sets/set1/generate-questions",
      body: { count: 3, topic: "loops" },
    });
    expect(await screen.findByText("Proposed one?")).toBeInTheDocument();
    expect(conversation()).toHaveTextContent("1 failed checks");
    await user.click(screen.getByRole("button", { name: "Save 1 as drafts" }));
    expect(calls[1]!.body).toEqual({ proposals: [proposal] });
  });

  it("asks for the count before generating", async () => {
    stubApi({
      "POST /api/ai/question-sets/set1/generate-questions": { body: { proposals: [], dropped: 0 } },
    });
    const user = setup({ enabled: true });
    await send(user, "generate some questions");
    expect(conversation()).toHaveTextContent("How many questions");
    expect(calls).toEqual([]);
    await send(user, "4 on recursion");
    expect(calls[0]!.body).toEqual({ count: 4, topic: "recursion" });
    expect(conversation()).toHaveTextContent("No usable questions came back");
  });

  it("keeps the existing propose and title controls", () => {
    setup({ enabled: true });
    expect(screen.getByRole("button", { name: "Propose questions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Suggest a title" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("heading", { name: "Assistant" }).closest("section")!).getByText(
        /proposals, not facts/,
      ),
    ).toBeInTheDocument();
  });
});
