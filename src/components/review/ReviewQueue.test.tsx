// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CheckResultView,
  QueueQuestionView,
  QueueRewriteView,
  ReviewQueueView,
} from "@/lib/client/types";
import { ReviewQueue } from "./ReviewQueue";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

afterEach(() => {
  cleanup();
  refresh.mockClear();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const NAMES: CheckResultView["name"][] = [
  "schema_valid",
  "supported_type",
  "correct_option_count",
  "source_ids",
  "excerpt_fidelity",
  "explanation_answer_agreement",
  "imported_key_agreement",
];
const checks = (over: Partial<Record<CheckResultView["name"], CheckResultView["result"]>> = {}) =>
  NAMES.map((name) => ({
    name,
    result: over[name] ?? (name === "schema_valid" ? "pass" : "not_applicable"),
  })) as CheckResultView[];

function item(id: string, over: Partial<QueueQuestionView> = {}): QueueQuestionView {
  return {
    kind: "question",
    setId: "set1",
    setTitle: "Week 1",
    question: {
      id: `q-${id}`,
      questionSetId: "set1",
      position: 0,
      status: "excluded",
      revisionId: `r-${id}`,
      revisionNumber: 1,
      type: "mcq_single",
      prompt: `Prompt ${id}`,
      codeSnippet: null,
      options: [
        { id: "a", text: "Alpha" },
        { id: "b", text: "Beta" },
      ],
      answerKey: { kind: "options", correctOptionIds: ["b"] },
      explanation: null,
      origin: "ai_proposed",
      evidenceStatus: "generated_unreviewed",
    },
    checks: checks(),
    recordedFailures: [],
    keyConflict: false,
    importedKey: null,
    citations: [],
    ...over,
  };
}

const queue = (
  questions: QueueQuestionView[],
  rewrites: QueueRewriteView[] = [],
): ReviewQueueView => ({ questions, rewrites });

describe("ReviewQueue", () => {
  it("says so when nothing is waiting", () => {
    render(<ReviewQueue courseId="c1" queue={queue([])} />);
    expect(screen.getByText(/Nothing is waiting for review/)).toBeInTheDocument();
  });

  it("shows what each check found, and never calls a check that had nothing to look at a pass", () => {
    render(<ReviewQueue courseId="c1" queue={queue([item("1")])} />);
    const list = screen.getByRole("list", { name: "Checks" });
    const row = (label: string) => within(list).getByText(label).closest("li")!;
    expect(within(row("Question is well formed")).getByText("Passed")).toBeInTheDocument();
    expect(
      within(row("Cited passages exist and are yours")).getByText("Not checked"),
    ).toBeInTheDocument();
    expect(screen.getByText(/cannot tell whether an answer is right/)).toBeInTheDocument();
    expect(screen.queryByText(/verified/i)).toBeNull();
  });

  it("needs the owner's tick before approving, then approves that revision", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return json({ question: {} });
      }),
    );
    const user = userEvent.setup();
    render(<ReviewQueue courseId="c1" queue={queue([item("1")])} />);
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    await user.click(screen.getByLabelText("I have checked this question and its answer"));
    await user.click(approve);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls).toEqual([
      { url: "/api/question-revisions/r-1/approve", body: { confirmed: true } },
    ]);
  });

  it("blocks approval when a required check failed, but still allows rejecting", async () => {
    const fetchMock = vi.fn(async (_url: string) => json({ question: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <ReviewQueue
        courseId="c1"
        queue={queue([item("1", { checks: checks({ source_ids: "fail" }) })])}
      />,
    );
    expect(screen.getByText(/A required check failed/)).toBeInTheDocument();
    await user.click(screen.getByLabelText("I have checked this question and its answer"));
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByLabelText(/Select: Prompt 1/)).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/question-revisions/r-1/reject");
  });

  it("keeps a failure recorded when the revision was made blocking, even if checks look fine now", () => {
    render(
      <ReviewQueue
        courseId="c1"
        queue={queue([item("1", { recordedFailures: ["source_ids"] })])}
      />,
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("shows the imported answer beside a conflict and asks for a reason", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)));
        return json({ question: {} });
      }),
    );
    const user = userEvent.setup();
    render(
      <ReviewQueue
        courseId="c1"
        queue={queue([
          item("1", {
            keyConflict: true,
            importedKey: { kind: "options", correctOptionIds: ["a"] },
            checks: checks({ imported_key_agreement: "fail" }),
          }),
        ])}
      />,
    );
    expect(screen.getByText(/differs from the imported one/)).toHaveTextContent("Alpha");
    expect(screen.getByLabelText(/Select: Prompt 1/)).toBeDisabled();
    await user.click(screen.getByLabelText("I have checked this question and its answer"));
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    await user.type(screen.getByLabelText("Why keep this answer?"), "Notes say B");
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ confirmed: true, keyConflictReason: "Notes say B" });
  });

  it("shows server errors and keeps the item", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ error: { code: "stale_revision", message: "This question changed." } }, 409),
      ),
    );
    const user = userEvent.setup();
    render(<ReviewQueue courseId="c1" queue={queue([item("1")])} />);
    await user.click(screen.getByLabelText("I have checked this question and its answer"));
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("This question changed.")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("selects only what can be approved and approves them together", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return json({ questions: [] });
      }),
    );
    const user = userEvent.setup();
    render(
      <ReviewQueue
        courseId="c1"
        queue={queue([
          item("1"),
          item("2", { checks: checks({ schema_valid: "fail" }) }),
          item("3"),
        ])}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Select all that can be approved" }));
    const bulk = screen.getByRole("button", { name: /Approve selected/ });
    expect(bulk).toHaveTextContent("(2)");
    expect(bulk).toBeDisabled();
    await user.click(
      screen.getByLabelText("I have checked the selected questions and their answers"),
    );
    await user.click(bulk);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      url: "/api/courses/c1/review-queue/approve-selected",
      body: { confirmed: true, revisionIds: ["r-1", "r-3"] },
    });
  });

  it("lists pending rewrites with a link to the editor and flags out-of-date ones", () => {
    render(
      <ReviewQueue
        courseId="c1"
        queue={queue(
          [],
          [
            {
              kind: "rewrite",
              id: "rw1",
              questionId: "q1",
              setId: "set9",
              setTitle: "Week 9",
              mode: "vary_numbers",
              content: { type: "mcq_single", prompt: "What is 5 + 6?" },
              stale: true,
              checks: checks(),
              keyConflict: true,
            },
          ],
        )}
      />,
    );
    expect(screen.getByText("Out of date")).toBeInTheDocument();
    expect(screen.getByText(/changes the answer from the imported one/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review in the editor" })).toHaveAttribute(
      "href",
      "/question-sets/set9/edit",
    );
  });

  it("opens a cited passage on request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ segment: { text: "Closures capture variables." } })),
    );
    const user = userEvent.setup();
    render(
      <ReviewQueue
        courseId="c1"
        queue={queue([
          item("1", {
            citations: [
              {
                segmentId: "s1",
                filename: "week1.docx",
                location: "paragraph 3",
                excerpt: "capture",
              },
            ],
          }),
        ])}
      />,
    );
    expect(screen.getByText(/week1.docx, paragraph 3/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show passage" }));
    expect(await screen.findByText("Closures capture variables.")).toBeInTheDocument();
  });
});
