// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerQuestionView } from "@/lib/client/types";
import { consentStatus } from "@/test/consent";
import { AssistantPanel } from "./AssistantPanel";
import { resetAiConsentCache } from "./AiConsent";
import { QuestionEditor } from "./editor/QuestionEditor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Routes by "METHOD /path"; each handler may be a function so replies can change per call. */
function stub(handlers: Record<string, (call: Call) => Response>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = {
        method: init?.method ?? "GET",
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const handler = handlers[`${call.method} ${url}`];
      if (!handler) throw new Error(`Unexpected request: ${call.method} ${url}`);
      return handler(call);
    }),
  );
}
const urls = () => calls.map((c) => `${c.method} ${c.url}`);

beforeEach(() => resetAiConsentCache());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function question(id: string, prompt: string): OwnerQuestionView {
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
    ],
    answerKey: { kind: "options", correctOptionIds: ["a"] },
    explanation: null,
    origin: "original",
    evidenceStatus: "human_reviewed",
  } as OwnerQuestionView;
}

function panel() {
  const user = userEvent.setup();
  render(
    <AssistantPanel
      enabled
      questionSetId="set1"
      courseId="course1"
      setTitle="Week 1"
      questions={[question("q1", "What is red?"), question("q2", "What is green?")]}
    />,
  );
  return user;
}
async function send(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByLabelText("Your message"), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
}
const dialog = () => screen.queryByRole("dialog");
const accept = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Accept and continue" }));
const decline = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /No thanks/ }));

const chatOk = () => json({ reply: "Hello there." });

describe("notice before the first AI action", () => {
  it("opens the notice before any model request, then sends the chat once after Accept", async () => {
    stub({
      "GET /api/ai/consent": () => json(consentStatus(false)),
      "POST /api/ai/consent": () => json(consentStatus(true)),
      "POST /api/ai/chat": chatOk,
    });
    const user = panel();
    await send(user, "explain lists");

    expect(await screen.findByRole("dialog", { name: /Before you use AI help/ })).toBeVisible();
    expect(urls()).toEqual(["GET /api/ai/consent"]);
    expect(screen.getByText(/can be used to improve its products/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Gemini API terms/ });
    expect(link).toHaveAttribute("href", "https://ai.google.dev/gemini-api/terms");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));

    await accept(user);
    expect(await screen.findByText("Hello there.")).toBeInTheDocument();
    expect(dialog()).toBeNull();
    expect(urls()).toEqual(["GET /api/ai/consent", "POST /api/ai/consent", "POST /api/ai/chat"]);
    expect(calls[1]!.body).toEqual({ noticeVersion: "v1", accepted: true });

    // Known to be accepted now: no further check or modal.
    await send(user, "and tuples?");
    await screen.findAllByText("Hello there.");
    expect(urls().filter((u) => u.includes("/api/ai/consent"))).toHaveLength(2);
    expect(dialog()).toBeNull();
  });

  it("skips the modal when the server already has current consent", async () => {
    stub({ "GET /api/ai/consent": () => json(consentStatus(true)), "POST /api/ai/chat": chatOk });
    const user = panel();
    await send(user, "explain lists");
    expect(await screen.findByText("Hello there.")).toBeInTheDocument();
    expect(dialog()).toBeNull();
  });

  it("sends nothing when declined, says so, and local edit commands still work", async () => {
    stub({ "GET /api/ai/consent": () => json(consentStatus(false)) });
    const user = panel();
    await send(user, "explain lists");
    await decline(user);

    expect(dialog()).toBeNull();
    expect(urls()).toEqual(["GET /api/ai/consent"]);
    expect(screen.getByText(/AI help stays off until you accept/)).toBeInTheDocument();

    // An edit command needs no AI and no notice.
    await send(user, "shuffle the questions");
    expect(
      await screen.findByRole("group", { name: "Change waiting for your confirmation" }),
    ).toBeInTheDocument();
    expect(dialog()).toBeNull();
    expect(urls()).toEqual(["GET /api/ai/consent"]);
  });

  it("never asks for edit commands", async () => {
    stub({});
    const user = panel();
    await send(user, "shuffle the questions");
    expect(
      await screen.findByRole("group", { name: "Change waiting for your confirmation" }),
    ).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("asks before proposing questions and sends no request when declined", async () => {
    stub({
      "GET /api/ai/consent": () => json(consentStatus(false)),
      "POST /api/ai/consent": () => json(consentStatus(true)),
      "POST /api/ai/question-sets/set1/generate-questions": () =>
        json({ proposals: [], dropped: 0 }),
    });
    const user = panel();
    await user.click(screen.getByRole("button", { name: "Propose questions" }));
    await decline(user);
    expect(urls()).toEqual(["GET /api/ai/consent"]);
    expect(await screen.findByText(/AI help stays off/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Propose questions" }));
    await accept(user);
    expect(await screen.findByText(/No usable questions/)).toBeInTheDocument();
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/ai/question-sets/set1/generate-questions",
      body: { count: 5 },
    });
  });

  it("asks before suggesting a title", async () => {
    stub({
      "GET /api/ai/consent": () => json(consentStatus(false)),
      "POST /api/ai/consent": () => json(consentStatus(true)),
      "POST /api/ai/question-sets/set1/suggest-title": () => json({ title: "Colors" }),
    });
    const user = panel();
    await user.click(screen.getByRole("button", { name: "Suggest a title" }));
    await accept(user);
    expect(await screen.findByText("Colors")).toBeInTheDocument();
  });

  it("keeps the notice open and sends nothing when saving the acceptance fails", async () => {
    stub({
      "GET /api/ai/consent": () => json(consentStatus(false)),
      "POST /api/ai/consent": () => json({ error: { code: "error", message: "Try later." } }, 500),
    });
    const user = panel();
    await send(user, "explain lists");
    await accept(user);
    expect(await screen.findByText("Try later.")).toBeInTheDocument();
    expect(dialog()).not.toBeNull();
    expect(urls()).toEqual(["GET /api/ai/consent", "POST /api/ai/consent"]);
  });
});

describe("a notice version change", () => {
  it("reopens the notice with the new version when the server says consent is required", async () => {
    let version = "v1";
    let serverAccepted = true;
    stub({
      "GET /api/ai/consent": () => json(consentStatus(serverAccepted, version)),
      "POST /api/ai/consent": () => {
        serverAccepted = true;
        return json(consentStatus(true, version));
      },
      "POST /api/ai/chat": () =>
        serverAccepted
          ? chatOk()
          : json(
              {
                error: {
                  code: "consent_required",
                  message: "Read and accept the AI data notice before using AI help.",
                  details: { noticeVersion: "v2" },
                },
              },
              403,
            ),
    });
    const user = panel();
    await send(user, "first");
    expect(await screen.findByText("Hello there.")).toBeInTheDocument();

    // The notice changes while this tab stays open.
    version = "v2";
    serverAccepted = false;
    await send(user, "second");
    expect(await screen.findByText(/notice changed/)).toBeInTheDocument();
    expect(dialog()).toBeNull();
    const chats = () => urls().filter((u) => u === "POST /api/ai/chat").length;
    expect(chats()).toBe(2);

    // The next action asks again, and accepting names the new version. Nothing is retried silently.
    await send(user, "third");
    await screen.findByRole("dialog");
    await accept(user);
    await screen.findAllByText("Hello there.");
    expect(calls.find((c) => c.method === "POST" && c.url === "/api/ai/consent")?.body).toEqual({
      noticeVersion: "v2",
      accepted: true,
    });
    expect(chats()).toBe(3);
  });

  it("shows the newer notice when the version changes while the dialog is open", async () => {
    let gets = 0;
    stub({
      "GET /api/ai/consent": () => json(consentStatus(false, gets++ === 0 ? "v1" : "v2")),
      "POST /api/ai/consent": () =>
        json(
          {
            error: {
              code: "notice_version_changed",
              message: "The AI notice has changed.",
              details: { noticeVersion: "v2" },
            },
          },
          409,
        ),
    });
    const user = panel();
    await send(user, "explain lists");
    await accept(user);
    expect(await screen.findByText(/changed while this was open/)).toBeInTheDocument();
    expect(dialog()).not.toBeNull();
    expect(urls()).not.toContain("POST /api/ai/chat");
  });
});

describe("keyboard use", () => {
  it("focuses Accept, traps Tab inside the dialog, and treats Escape as declining", async () => {
    stub({ "GET /api/ai/consent": () => json(consentStatus(false)) });
    const user = panel();
    await send(user, "explain lists");
    const acceptButton = await screen.findByRole("button", { name: "Accept and continue" });
    expect(acceptButton).toHaveFocus();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");

    await user.tab();
    expect(screen.getByRole("button", { name: /No thanks/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: /Gemini API terms/ })).toHaveFocus();
    await user.tab();
    expect(acceptButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("link", { name: /Gemini API terms/ })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(dialog()).toBeNull();
    expect(urls()).toEqual(["GET /api/ai/consent"]);
  });
});

describe("rewriting a question", () => {
  const rewrite = "POST /api/ai/questions/q1/rewrite";
  const proposal = () =>
    json({
      proposal: {
        mode: "rephrase",
        baseRevisionId: "r-q1",
        content: {
          type: "mcq_single",
          prompt: "Which color is red?",
          options: [
            { id: "a", text: "red" },
            { id: "b", text: "green" },
          ],
          correctOptionIds: ["a"],
        },
        origin: "ai_variant",
        evidenceStatus: "needs_review",
        warnings: [],
      },
    });

  it("asks first, sends nothing when declined, and rewrites after Accept", async () => {
    stub({
      "GET /api/ai/consent": () => json(consentStatus(false)),
      "POST /api/ai/consent": () => json(consentStatus(true)),
      [rewrite]: proposal,
    });
    const user = userEvent.setup();
    render(
      <QuestionEditor
        questionSetId="set1"
        questions={[question("q1", "What is red?")]}
        aiEnabled
      />,
    );

    await user.click(screen.getByRole("button", { name: "Rephrase" }));
    await decline(user);
    expect(urls()).toEqual(["GET /api/ai/consent"]);
    expect(await screen.findByText(/AI help stays off/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Rephrase" }));
    await accept(user);
    expect(await screen.findByLabelText("Proposed rewrite")).toBeInTheDocument();
    expect(urls().filter((u) => u === rewrite)).toHaveLength(1);
  });

  it("does not ask when AI is off", async () => {
    stub({});
    render(<QuestionEditor questionSetId="set1" questions={[question("q1", "What is red?")]} />);
    expect(screen.queryByRole("button", { name: "Rephrase" })).toBeNull();
    expect(calls).toEqual([]);
  });
});
