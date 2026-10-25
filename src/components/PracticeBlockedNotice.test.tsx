// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NeedsReviewNote, PracticeBlockedNotice } from "./PracticeBlockedNotice";

afterEach(cleanup);

const counts = (o: Partial<Parameters<typeof PracticeBlockedNotice>[0]["counts"]>) => ({
  total: 0,
  playable: 0,
  needsReview: 0,
  noAnswer: 0,
  excluded: 0,
  ...o,
});

describe("PracticeBlockedNotice", () => {
  it("renders nothing when something can be practised", () => {
    const { container } = render(
      <PracticeBlockedNotice
        questionSetId="s"
        counts={counts({ total: 3, playable: 1, needsReview: 2 })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names the reason and links to the matching editor view", () => {
    render(
      <PracticeBlockedNotice questionSetId="s" counts={counts({ total: 4, needsReview: 4 })} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("All 4 questions need review");
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/question-sets/s/edit?filter=needs-review",
    );
  });

  it("invites adding questions to an empty set", () => {
    render(<PracticeBlockedNotice questionSetId="s" counts={counts({})} />);
    expect(screen.getByText(/no questions yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add questions in the editor" })).toHaveAttribute(
      "href",
      "/question-sets/s/edit",
    );
  });
});

describe("NeedsReviewNote", () => {
  it("shows only when some can be practised and some need review", () => {
    const { container, rerender } = render(
      <NeedsReviewNote
        questionSetId="s"
        counts={counts({ total: 3, playable: 1, needsReview: 2 })}
      />,
    );
    expect(container).toHaveTextContent("2 questions need review before they can be practised.");
    rerender(
      <NeedsReviewNote
        questionSetId="s"
        counts={counts({ total: 3, playable: 0, needsReview: 3 })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<NeedsReviewNote questionSetId="s" counts={counts({ total: 3, playable: 3 })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("uses the singular form", () => {
    const { container } = render(
      <NeedsReviewNote
        questionSetId="s"
        counts={counts({ total: 2, playable: 1, needsReview: 1 })}
      />,
    );
    expect(container).toHaveTextContent("1 question needs review before it can be practised.");
  });
});
