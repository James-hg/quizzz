// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerQuestionView } from "@/lib/client/types";
import { QuestionEditor } from "./QuestionEditor";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
afterEach(cleanup);

function question(
  id: string,
  over: Partial<OwnerQuestionView> & { unresolvedKey?: boolean } = {},
): OwnerQuestionView {
  const { unresolvedKey, ...rest } = over;
  return {
    id,
    questionSetId: "set1",
    position: 0,
    status: "active",
    revisionId: `r-${id}`,
    revisionNumber: 1,
    type: "mcq_single",
    prompt: `Prompt ${id}`,
    codeSnippet: null,
    options: [
      { id: "a", text: "x" },
      { id: "b", text: "y" },
    ],
    answerKey: unresolvedKey
      ? { kind: "unresolved" }
      : { kind: "options", correctOptionIds: ["a"] },
    explanation: null,
    origin: "original",
    evidenceStatus: "human_reviewed",
    ...rest,
  } as OwnerQuestionView;
}

const questions = [
  question("ok"),
  question("review1", { origin: "sample", evidenceStatus: "needs_review" }),
  question("review2", { origin: "sample", evidenceStatus: "needs_review" }),
  question("noanswer", { status: "excluded", evidenceStatus: "unresolved", unresolvedKey: true }),
  question("out", { status: "excluded" }),
];

describe("QuestionEditor filter", () => {
  it("shows every question and counts per filter by default", () => {
    render(<QuestionEditor questionSetId="set1" questions={questions} />);
    expect(screen.getAllByRole("article")).toHaveLength(5);
    const nav = screen.getByRole("navigation", { name: "Filter questions" });
    expect(within(nav).getByRole("link", { name: "All (5)" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Needs review (2)" })).toHaveAttribute(
      "href",
      "/question-sets/set1/edit?filter=needs-review",
    );
    expect(within(nav).getByRole("link", { name: "No answer (1)" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Excluded (1)" })).toBeInTheDocument();
  });

  it("lists only questions that need review, keeping their original numbers", () => {
    render(<QuestionEditor questionSetId="set1" questions={questions} filter="needs-review" />);
    const cards = screen.getAllByRole("article");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Question 2", "Question 3"]);
    expect(
      within(screen.getByRole("navigation")).getByRole("link", { name: "Needs review (2)" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("filters unanswered and excluded questions separately", () => {
    const { rerender } = render(
      <QuestionEditor questionSetId="set1" questions={questions} filter="no-answer" />,
    );
    expect(screen.getAllByRole("article").map((c) => c.getAttribute("aria-label"))).toEqual([
      "Question 4",
    ]);
    rerender(<QuestionEditor questionSetId="set1" questions={questions} filter="excluded" />);
    expect(screen.getAllByRole("article").map((c) => c.getAttribute("aria-label"))).toEqual([
      "Question 5",
    ]);
  });

  it("hides the reorder arrows while filtered, so order changes stay unambiguous", () => {
    const { rerender } = render(<QuestionEditor questionSetId="set1" questions={questions} />);
    expect(screen.getAllByRole("button", { name: /Move question/ }).length).toBeGreaterThan(0);
    rerender(<QuestionEditor questionSetId="set1" questions={questions} filter="needs-review" />);
    expect(screen.queryByRole("button", { name: /Move question/ })).not.toBeInTheDocument();
  });

  it("says when no question matches and offers to show all", () => {
    render(
      <QuestionEditor questionSetId="set1" questions={[question("ok")]} filter="needs-review" />,
    );
    expect(screen.getByText("No questions match this filter.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Show all questions" })).toHaveAttribute(
      "href",
      "/question-sets/set1/edit",
    );
  });

  it("shows no filter bar for an empty set", () => {
    render(<QuestionEditor questionSetId="set1" questions={[]} />);
    expect(screen.queryByRole("navigation", { name: "Filter questions" })).not.toBeInTheDocument();
    expect(screen.getByText("No questions yet.")).toBeInTheDocument();
  });
});
