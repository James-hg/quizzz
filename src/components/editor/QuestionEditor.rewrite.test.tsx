// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerQuestionView, SavedRewriteView } from "@/lib/client/types";
import { QuestionEditor } from "./QuestionEditor";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

afterEach(() => {
  cleanup();
  refresh.mockClear();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function question(over: Partial<OwnerQuestionView> = {}): OwnerQuestionView {
  return {
    id: "q1",
    questionSetId: "set1",
    position: 0,
    status: "active",
    revisionId: "r1",
    revisionNumber: 1,
    type: "mcq_single",
    prompt: "What is 2 + 3?",
    codeSnippet: null,
    options: [
      { id: "a", text: "5" },
      { id: "b", text: "6" },
    ],
    answerKey: { kind: "options", correctOptionIds: ["a"] },
    explanation: null,
    origin: "original",
    evidenceStatus: "human_reviewed",
    ...over,
  } as OwnerQuestionView;
}

function saved(over: Partial<SavedRewriteView> = {}): SavedRewriteView {
  return {
    id: "rw1",
    questionId: "q1",
    mode: "vary_numbers",
    content: {
      type: "mcq_single",
      prompt: "What is 4 + 3?",
      options: [
        { id: "a", text: "7" },
        { id: "b", text: "8" },
      ],
      correctOptionIds: ["a"],
    },
    origin: "ai_variant",
    evidenceStatus: "needs_review",
    stale: false,
    createdAt: "2026-10-28T00:00:00.000Z",
    ...over,
  };
}

describe("QuestionEditor AI rewriting", () => {
  it("offers no rewrite buttons when AI is off", () => {
    render(<QuestionEditor questionSetId="set1" questions={[question()]} />);
    expect(screen.queryByRole("group", { name: "Rewrite with AI" })).toBeNull();
  });

  it("disables 'Vary numbers' for a question without numbers", () => {
    render(
      <QuestionEditor
        questionSetId="set1"
        questions={[question({ prompt: "Name the capital of France" })]}
        aiEnabled
      />,
    );
    expect(screen.getByRole("button", { name: "Vary numbers" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rephrase" })).toBeEnabled();
  });

  it("shows the original beside the proposal and saves it only on request", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.startsWith("/api/ai/")) {
          return json({
            proposal: {
              mode: "vary_numbers",
              baseRevisionId: "r1",
              content: saved().content,
              origin: "ai_variant",
              evidenceStatus: "needs_review",
              warnings: ["The answer was worked out by the AI. Check it."],
            },
          });
        }
        return json({ rewrite: { id: "rw1" } }, 201);
      }),
    );
    const user = userEvent.setup();
    render(<QuestionEditor questionSetId="set1" questions={[question()]} aiEnabled />);

    await user.click(screen.getByRole("button", { name: "Vary numbers" }));
    const proposed = await screen.findByLabelText("Proposed rewrite");
    expect(within(proposed).getByText("Needs review")).toBeInTheDocument();
    expect(within(proposed).getByLabelText("Original")).toHaveTextContent("What is 2 + 3?");
    expect(within(proposed).getByLabelText("Proposed")).toHaveTextContent("What is 4 + 3?");
    expect(within(proposed).getByText(/Check it/)).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "/api/ai/questions/q1/rewrite",
      body: { mode: "vary_numbers" },
    });

    await user.click(within(proposed).getByRole("button", { name: "Save proposal" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls[1]).toMatchObject({
      url: "/api/questions/q1/rewrites",
      body: { mode: "vary_numbers", baseRevisionId: "r1" },
    });
  });

  it("shows an AI failure without a proposal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          { error: { code: "ai_invalid_output", message: "The AI gave an unusable answer." } },
          502,
        ),
      ),
    );
    const user = userEvent.setup();
    render(<QuestionEditor questionSetId="set1" questions={[question()]} aiEnabled />);
    await user.click(screen.getByRole("button", { name: "Rephrase" }));
    expect(await screen.findByText(/unusable answer/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Proposed rewrite")).toBeNull();
  });
});

describe("saved rewrite proposals", () => {
  it("shows saved proposals even when AI is off, and requires a check before accepting", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return json({ question: { id: "q1" } }, 201);
      }),
    );
    const user = userEvent.setup();
    render(
      <QuestionEditor questionSetId="set1" questions={[question()]} rewrites={{ q1: [saved()] }} />,
    );
    const group = screen.getByRole("group", { name: /Saved Vary numbers proposal/ });
    const accept = within(group).getByRole("button", { name: /new version/ });
    expect(accept).toBeDisabled();
    await user.click(within(group).getByLabelText(/I have checked/));
    await user.click(accept);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({
      url: "/api/rewrites/rw1/accept",
      body: { confirmed: true, as: "revision" },
    });
  });

  it("only allows a new question when the proposal is out of date", async () => {
    render(
      <QuestionEditor
        questionSetId="set1"
        questions={[question()]}
        rewrites={{ q1: [saved({ stale: true })] }}
      />,
    );
    const group = screen.getByRole("group", { name: /Saved Vary numbers proposal/ });
    await userEvent.click(within(group).getByLabelText(/I have checked/));
    expect(within(group).getByRole("button", { name: /new version/ })).toBeDisabled();
    expect(within(group).getByRole("button", { name: "Add as a new question" })).toBeEnabled();
  });

  it("dismisses a proposal", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <QuestionEditor questionSetId="set1" questions={[question()]} rewrites={{ q1: [saved()] }} />,
    );
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/rewrites/rw1/dismiss",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
