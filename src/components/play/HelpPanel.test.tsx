// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStatus, HelpResult } from "@/lib/client/types";
import { PlayScreen } from "./PlayScreen";
import { HelpPanel } from "./HelpPanel";
import { result, results, session } from "./test-helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const help = (over: Partial<HelpResult> = {}): HelpResult => ({
  id: "h1",
  questionId: "q1",
  pass: 1,
  action: "small_hint",
  level: "conceptual_hint",
  text: "Think about what B stands for.",
  citations: [],
  sourceSupported: false,
  origin: "approved",
  servedAs: "requested",
  ...over,
});

const sse = (text: string, final: HelpResult | null = help({ text })) => {
  const encoder = new TextEncoder();
  const parts = [
    `event: text\ndata: ${JSON.stringify({ text: text.slice(0, 10) })}\n\n`,
    `event: text\ndata: ${JSON.stringify({ text: text.slice(10) })}\n\n`,
    ...(final ? [`event: done\ndata: ${JSON.stringify({ help: final })}\n\n`] : []),
  ];
  return new Response(
    new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(encoder.encode(p));
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[];
let helpReply: (call: Call) => Response | Promise<Response>;
let aiStatus: AiStatus;

function stubNarrow(narrow: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: narrow,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
  // jsdom's window is not the same object as the global, so set it on both.
  window.matchMedia = globalThis.matchMedia;
}

beforeEach(() => {
  calls = [];
  aiStatus = { state: "available", message: "ok" };
  helpReply = () => sse("Think about what B stands for.");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      if (url === "/api/ai/status") return json(aiStatus);
      if (url.endsWith("/help")) return helpReply(call);
      if (url.endsWith("/results")) return json({ results: results() });
      throw new Error(`unexpected request ${url}`);
    }),
  );
  stubNarrow(false);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const helpCalls = () => calls.filter((c) => c.url.endsWith("/help"));
const play = (over = {}) => render(<PlayScreen initial={session(over)} setTitle="Week 1" />);

describe("help in the play screen", () => {
  it("offers all five kinds of help beside the question", () => {
    play();
    const list = screen.getByRole("list", { name: "Kinds of help" });
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "Small hint",
      "Explain the next step",
      "Why was I wrong?",
      "Show a similar example",
      "Full explanation",
    ]);
  });

  it.each([
    ["exam practice", { mode: "exam", revealMode: "end" as const }],
    ["a results-at-the-end session", { revealMode: "end" as const }],
  ])("offers no help in %s", (_l, over) => {
    play(over);
    expect(screen.queryByRole("list", { name: "Kinds of help" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Get help" })).toBeNull();
    expect(calls.some((c) => c.url === "/api/ai/status")).toBe(false);
  });

  it("asks only for the question and the kind of help, and shows the recorded reply", async () => {
    const user = userEvent.setup();
    play();
    await user.click(screen.getByRole("button", { name: "Small hint" }));
    expect(await screen.findByText("Think about what B stands for.")).toBeInTheDocument();
    expect(helpCalls()).toHaveLength(1);
    expect(helpCalls()[0]!.body).toEqual({ questionId: "q1", action: "small_hint" });
    expect(helpCalls()[0]!.headers.Accept).toBe("text/event-stream");
    expect(screen.getByText("Reviewed hint")).toBeInTheDocument();
    expect(screen.getByText(/This help is recorded/)).toBeInTheDocument();
  });

  it("labels generated help as such and shows uncertainty and the lack of a source", async () => {
    helpReply = () =>
      sse("Try tracing it.", help({ origin: "ai_proposed", uncertainty: "the notes are vague" }));
    const user = userEvent.setup();
    play();
    await user.click(screen.getByRole("button", { name: "Explain the next step" }));
    expect(await screen.findByText("AI-generated, may be wrong")).toBeInTheDocument();
    expect(screen.getByText(/Not sure about: the notes are vague/)).toBeInTheDocument();
    expect(screen.getByText("Not backed by a passage from your notes.")).toBeInTheDocument();
  });

  it("says when a general hint stood in for the help that was asked for", async () => {
    helpReply = () => sse("A general hint.", help({ servedAs: "fallback_hint" }));
    const user = userEvent.setup();
    play();
    await user.click(screen.getByRole("button", { name: "Full explanation" }));
    expect(await screen.findByText(/tailored help was not available/)).toBeInTheDocument();
  });

  it("opens a cited passage through the address the server gave", async () => {
    helpReply = () =>
      sse(
        "See the notes.",
        help({
          sourceSupported: true,
          citations: [
            {
              segmentId: "s9",
              href: "/api/sources/segments/s9",
              filename: "week1.docx",
              location: "paragraph 3",
            },
          ],
        }),
      );
    const original = fetch as unknown as ReturnType<typeof vi.fn>;
    const user = userEvent.setup();
    play();
    await user.click(screen.getByRole("button", { name: "Small hint" }));
    expect(await screen.findByText(/week1.docx, paragraph 3/)).toBeInTheDocument();
    original.mockImplementationOnce(async () =>
      json({ segment: { text: "Closures capture variables." } }),
    );
    await user.click(screen.getByRole("button", { name: "Show passage" }));
    expect(await screen.findByText("Closures capture variables.")).toBeInTheDocument();
    expect(original.mock.calls.at(-1)![0]).toBe("/api/sources/segments/s9");
  });

  it("does not show partial text as help when the stream is cut off, and allows a retry", async () => {
    let n = 0;
    helpReply = () =>
      n++ === 0 ? sse("This reply never finishes.", null) : sse("Second try works.");
    const user = userEvent.setup();
    play();
    await user.click(screen.getByRole("button", { name: "Small hint" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/cut off/);
    expect(screen.queryByText("This reply never finishes.")).toBeNull();
    expect(screen.queryByText(/This help is recorded/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Second try works.")).toBeInTheDocument();
    expect(helpCalls()).toHaveLength(2);
  });

  it.each([
    ["no_wrong_answer", 409, /not answered this question wrongly/],
    ["stale_turn", 409, /moved on to another question/],
    ["help_not_available_yet", 403, /second try|tried again/i],
    ["ai_unavailable", 503, /not available right now/],
  ])("explains %s plainly", async (code, status, message) => {
    helpReply = () =>
      json({ error: { code, message: "AI help is not available right now." } }, status);
    const user = userEvent.setup();
    play();
    await user.click(screen.getByRole("button", { name: "Why was I wrong?" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    // Practice carries on: the answer form is untouched.
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeInTheDocument();
  });

  it("falls back to a JSON reply when the server does not stream", async () => {
    helpReply = () => json({ help: help({ text: "Plain reply." }) });
    const user = userEvent.setup();
    play();
    await user.click(screen.getByRole("button", { name: "Small hint" }));
    expect(await screen.findByText("Plain reply.")).toBeInTheDocument();
  });

  it("clears help on the next question and ignores a reply that arrives late", async () => {
    let release!: (r: Response) => void;
    helpReply = () => new Promise<Response>((resolve) => (release = resolve));
    const user = userEvent.setup();
    const { rerender } = play();
    await user.click(screen.getByRole("button", { name: "Small hint" }));
    expect(await screen.findByText("Getting help…")).toBeInTheDocument();

    rerender(
      <PlayScreen
        key="next"
        initial={session({
          current: { ...session().current!, questionId: "q2", prompt: "Second" },
        })}
        setTitle="Week 1"
      />,
    );
    await act(async () => release(sse("Late reply for the old question.")));
    expect(screen.queryByText("Late reply for the old question.")).toBeNull();
    expect(screen.queryByText("Getting help…")).toBeNull();
  });

  it("offers only a small hint and help with a mistake on the second try", () => {
    play({
      revealMode: "requeue",
      current: { ...session().current!, pass: 2 },
    });
    const list = screen.getByRole("list", { name: "Kinds of help" });
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Small hint", "Why was I wrong?"]);
    expect(screen.getByText(/only a small hint or help with your mistake/i)).toBeInTheDocument();
  });

  it("is switched off once the answer is in, and not shown while paused", async () => {
    const user = userEvent.setup();
    const { rerender } = play();
    expect(screen.getByRole("button", { name: "Small hint" })).toBeEnabled();
    rerender(<PlayScreen key="p" initial={session({ state: "paused" })} setTitle="Week 1" />);
    expect(screen.queryByRole("list", { name: "Kinds of help" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Paused" })).toBeInTheDocument();
    void user;
  });

  it("keeps practice usable with AI off, says so, and still lets help be asked for", async () => {
    aiStatus = { state: "disabled", message: "AI help is not configured on this server." };
    helpReply = () =>
      json(
        { error: { code: "ai_unavailable", message: "AI help is not available right now." } },
        503,
      );
    const user = userEvent.setup();
    play();
    expect(await screen.findByText(/AI help is off on this server/)).toBeInTheDocument();
    await user.click(screen.getByLabelText("A"));
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Small hint" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("says when AI help is paused", async () => {
    aiStatus = { state: "paused", message: "paused", retryAt: "2026-11-07T00:00:00Z" };
    play();
    expect(await screen.findByText(/AI help is paused for now/)).toBeInTheDocument();
  });

  it("works for a course session: links stay on the course, never a question set", () => {
    play({ questionSetId: null, mode: "review", revealMode: "requeue", timeBudgetMinutes: 10 });
    expect(screen.getByRole("link", { name: "Week 1" })).toHaveAttribute("href", "/courses/c1");
    expect(screen.getByText("10 minute plan")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("question-sets/null");
  });
});

describe("the help drawer on a narrow screen", () => {
  const props = {
    sessionId: "s1",
    questionId: "q1",
    pass: 1 as const,
    canAsk: true,
    aiStatus: null,
  };

  it("is closed until asked for, then a labelled dialog that holds focus", async () => {
    stubNarrow(true);
    const user = userEvent.setup();
    render(<HelpPanel {...props} />);
    const open = screen.getByRole("button", { name: "Get help" });
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(open);
    const dialog = screen.getByRole("dialog", { name: "Help with this question" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(screen.getByRole("button", { name: "Close help" })).toHaveFocus());

    // Tab stays inside, wrapping from the last control to the first.
    const controls = within(dialog).getAllByRole("button");
    controls[controls.length - 1]!.focus();
    await user.tab();
    expect(controls[0]).toHaveFocus();
    await user.tab({ shift: true });
    expect(controls[controls.length - 1]).toHaveFocus();
  });

  it("closes with Escape and returns focus to the button that opened it", async () => {
    stubNarrow(true);
    const user = userEvent.setup();
    render(<HelpPanel {...props} />);
    const open = screen.getByRole("button", { name: "Get help" });
    await user.click(open);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(open).toHaveFocus();
  });

  it("closes with its own button, and keeps the help it already fetched", async () => {
    stubNarrow(true);
    const user = userEvent.setup();
    render(<HelpPanel {...props} />);
    await user.click(screen.getByRole("button", { name: "Get help" }));
    await user.click(screen.getByRole("button", { name: "Small hint" }));
    expect(await screen.findByText("Think about what B stands for.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close help" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Get help" }));
    expect(screen.getByText("Think about what B stands for.")).toBeInTheDocument();
  });

  it("is a column beside the question, not a dialog, on a wide screen", () => {
    render(<HelpPanel {...props} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("complementary", { name: "Help with this question" }),
    ).toBeInTheDocument();
  });
});

describe("answering with help", () => {
  it("still submits normally after help, with nothing about help in the answer", async () => {
    let answerBody: unknown;
    const base = fetch as unknown as ReturnType<typeof vi.fn>;
    const wrapped = base.getMockImplementation() as (
      u: string,
      i?: RequestInit,
    ) => Promise<Response>;
    base.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/answers")) {
        answerBody = JSON.parse(String(init?.body));
        return json(
          {
            replayed: false,
            result: result("correct"),
            progress: { answered: 1, total: 2 },
            requeued: false,
          },
          201,
        );
      }
      return wrapped(url, init);
    });
    const user = userEvent.setup();
    play();
    await user.click(screen.getByRole("button", { name: "Small hint" }));
    await screen.findByText("Think about what B stands for.");
    await user.click(screen.getByLabelText("B"));
    await user.click(screen.getByRole("button", { name: "Submit answer" }));
    await screen.findByText(/Correct/);
    // The browser never says it was assisted: the server derives that from the recorded help.
    expect(Object.keys(answerBody as object).sort()).toEqual([
      "idempotencyKey",
      "pass",
      "questionId",
      "response",
    ]);
    expect(screen.getByRole("button", { name: "Small hint" })).toBeDisabled();
  });
});
