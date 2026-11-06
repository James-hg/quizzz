// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionResults as Results } from "@/lib/client/types";
import { results } from "./test-helpers";
import { SessionResults } from "./SessionResults";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function show(data: Results, props: { questionSetId?: string | null } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(data)),
  );
  render(
    <SessionResults
      sessionId="s1"
      questionSetId={props.questionSetId === undefined ? "set1" : props.questionSetId}
      courseId="c1"
    />,
  );
}

describe("SessionResults", () => {
  it("shows independent and assisted answers apart", async () => {
    show(
      results({
        firstPass: {
          answered: 4,
          independentCorrect: 2,
          assistedCorrect: 1,
          incorrect: 1,
          uncertain: 0,
          unanswered: 0,
        },
        uniqueQuestions: 4,
        attempts: 4,
      }),
    );
    expect(await screen.findByText("3 correct out of 4 answered")).toBeInTheDocument();
    expect(screen.getByText(/Right on your own: 2 · right with help: 1/)).toBeInTheDocument();
    expect(screen.getByText(/different evidence/)).toBeInTheDocument();
    expect(screen.getByText("Not right: 1")).toBeInTheDocument();
  });

  it("counts attempts and distinct questions separately, and retries apart", async () => {
    show(
      results({
        uniqueQuestions: 3,
        attempts: 4,
        retry: { total: 2, answered: 1, correct: 1, incorrect: 0, uncertain: 0 },
      }),
    );
    expect(
      await screen.findByText(/Questions: 3 answered · answers recorded: 4/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Second tries: 1 correct out of 1 \(1 not tried\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(/on the first try/)).toBeInTheDocument();
  });

  it("says plainly when nothing was answered, and when no review is planned", async () => {
    show(
      results({
        uniqueQuestions: 0,
        attempts: 0,
        firstPass: {
          answered: 0,
          independentCorrect: 0,
          assistedCorrect: 0,
          incorrect: 0,
          uncertain: 0,
          unanswered: 5,
        },
      }),
    );
    expect(
      await screen.findByText("No questions were answered in this session"),
    ).toBeInTheDocument();
    expect(screen.getByText("Not answered: 5")).toBeInTheDocument();
    expect(screen.getByText("No review is planned yet.")).toBeInTheDocument();
  });

  it("does not call an unchecked answer a failure", async () => {
    show(
      results({
        firstPass: {
          answered: 2,
          independentCorrect: 1,
          assistedCorrect: 0,
          incorrect: 0,
          uncertain: 1,
          unanswered: 0,
        },
      }),
    );
    expect(await screen.findByText("Could not be checked automatically: 1")).toBeInTheDocument();
    expect(screen.queryByText(/Not right/)).toBeNull();
  });

  it("labels exam practice and an early end honestly, with the planned length", async () => {
    show(results({ mode: "exam", state: "abandoned", timeBudgetMinutes: 10, elapsedSeconds: 125 }));
    expect(await screen.findByText("Exam practice, not a grade")).toBeInTheDocument();
    expect(screen.getByText("Ended early")).toBeInTheDocument();
    expect(screen.getByText("Time: 2:05 of 10 minutes planned")).toBeInTheDocument();
  });

  it("lists question sets needing practice under that exact label, and the next review date", async () => {
    show(
      results({
        questionSetsNeedingPractice: [
          { questionSetId: "set9", title: "Week 9", missed: 2, assisted: 1, unchecked: 0 },
        ],
        nextReviewAt: "2026-11-10T08:00:00.000Z",
      }),
    );
    expect(await screen.findByText("Question sets needing practice")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Week 9" })).toHaveAttribute(
      "href",
      "/question-sets/set9/edit",
    );
    expect(screen.getByText("2 misses · 1 with help")).toBeInTheDocument();
    expect(screen.getByText(/Next planned review: /)).toBeInTheDocument();
  });

  it("links a course session back to the course, not to a question set", async () => {
    show(results(), { questionSetId: null });
    expect(await screen.findByRole("link", { name: "Back to the course" })).toHaveAttribute(
      "href",
      "/courses/c1",
    );
    expect(screen.queryByRole("link", { name: /question set/ })).toBeNull();
  });

  it("shows a retry, and no counts, when the report cannot be loaded", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? json(
              {
                error: {
                  code: "session_in_progress",
                  message: "Results are available when the session ends.",
                },
              },
              409,
            )
          : json(results());
      }),
    );
    const user = userEvent.setup();
    render(<SessionResults sessionId="s1" questionSetId="set1" courseId="c1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Results are available when the session ends.",
    );
    expect(screen.queryByText(/correct out of/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByText("1 correct out of 1 answered")).toBeInTheDocument(),
    );
  });
});
