// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartPracticeButton } from "./StartPracticeButton";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  push.mockReset();
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
}

describe("StartPracticeButton", () => {
  it("starts the session and goes to the play screen", async () => {
    stubFetch(201, { session: { id: "s1" } });
    const user = userEvent.setup();
    render(<StartPracticeButton questionSetId="set1" />);
    await user.click(screen.getByRole("button", { name: "Practice" }));
    expect(push).toHaveBeenCalledWith("/question-sets/set1/play/s1");
  });

  it("explains from the server's counts why nothing is playable, with a link to the fix", async () => {
    stubFetch(409, {
      error: {
        code: "no_playable_questions",
        message: "This question set has no questions that can be practiced.",
        details: { total: 30, playable: 0, needsReview: 30, noAnswer: 0, excluded: 0 },
      },
    });
    const user = userEvent.setup();
    render(<StartPracticeButton questionSetId="set1" />);
    await user.click(screen.getByRole("button", { name: "Practice" }));
    expect(
      await screen.findByText(/All 30 questions need review before they can be practised/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review them in the editor" })).toHaveAttribute(
      "href",
      "/question-sets/set1/edit?filter=needs-review",
    );
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Practice" })).toBeEnabled();
  });

  it("says there is no answer yet when that is the only reason", async () => {
    stubFetch(409, {
      error: {
        code: "no_playable_questions",
        message: "x",
        details: { total: 2, playable: 0, needsReview: 0, noAnswer: 2, excluded: 0 },
      },
    });
    const user = userEvent.setup();
    render(<StartPracticeButton questionSetId="set1" />);
    await user.click(screen.getByRole("button", { name: "Practice" }));
    expect(await screen.findByText(/No questions with an answer yet/)).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/question-sets/set1/edit?filter=no-answer",
    );
  });

  it("falls back to the server message for other errors", async () => {
    stubFetch(404, { error: { code: "not_found", message: "Question set not found" } });
    const user = userEvent.setup();
    render(<StartPracticeButton questionSetId="set1" />);
    await user.click(screen.getByRole("button", { name: "Practice" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Question set not found");
  });

  it("falls back to the message when the counts are missing", async () => {
    stubFetch(409, { error: { code: "no_playable_questions", message: "Nothing to practise." } });
    const user = userEvent.setup();
    render(<StartPracticeButton questionSetId="set1" />);
    await user.click(screen.getByRole("button", { name: "Practice" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing to practise.");
  });
});
