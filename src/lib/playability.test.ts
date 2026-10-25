import { describe, expect, it } from "vitest";
import {
  classifyQuestion,
  countPlayability,
  countsFromDetails,
  editorHref,
  explainNotPlayable,
  filterToFix,
  matchesFilter,
  parseFilter,
  type PlayabilityInput,
} from "./playability";

const q = (status: string, evidenceStatus: string, answerKind = "options"): PlayabilityInput => ({
  status,
  evidenceStatus,
  answerKind,
});

describe("classifyQuestion", () => {
  it("treats active questions with usable evidence as playable", () => {
    for (const evidence of [
      "human_reviewed",
      "unresolved",
      "source_linked",
      "deterministically_checked",
    ]) {
      expect(classifyQuestion(q("active", evidence))).toBe("playable");
    }
  });

  it("puts unreviewed content under needs_review, whatever its status", () => {
    expect(classifyQuestion(q("active", "needs_review"))).toBe("needs_review");
    expect(classifyQuestion(q("active", "generated_unreviewed"))).toBe("needs_review");
    expect(classifyQuestion(q("excluded", "generated_unreviewed"))).toBe("needs_review");
  });

  it("separates missing answers from other exclusions", () => {
    expect(classifyQuestion(q("excluded", "unresolved", "unresolved"))).toBe("no_answer");
    expect(classifyQuestion(q("excluded", "human_reviewed"))).toBe("excluded");
    expect(classifyQuestion(q("reported", "human_reviewed"))).toBe("excluded");
    expect(classifyQuestion(q("active", "rejected"))).toBe("excluded");
  });

  it("needs_review wins over no_answer", () => {
    expect(classifyQuestion(q("excluded", "needs_review", "unresolved"))).toBe("needs_review");
  });
});

describe("countPlayability", () => {
  it("counts every question exactly once", () => {
    const counts = countPlayability([
      q("active", "human_reviewed"),
      q("active", "needs_review"),
      q("excluded", "generated_unreviewed"),
      q("excluded", "unresolved", "unresolved"),
      q("excluded", "human_reviewed"),
    ]);
    expect(counts).toEqual({ total: 5, playable: 1, needsReview: 2, noAnswer: 1, excluded: 1 });
    expect(counts.playable + counts.needsReview + counts.noAnswer + counts.excluded).toBe(5);
  });
});

describe("explainNotPlayable", () => {
  const counts = (o: Partial<ReturnType<typeof countPlayability>>) => ({
    total: 0,
    playable: 0,
    needsReview: 0,
    noAnswer: 0,
    excluded: 0,
    ...o,
  });

  it("is null when something can be practised", () => {
    expect(explainNotPlayable(counts({ total: 3, playable: 1, needsReview: 2 }))).toBeNull();
  });

  it("explains each single reason", () => {
    expect(explainNotPlayable(counts({ total: 30, needsReview: 30 }))).toBe(
      "All 30 questions need review before they can be practised.",
    );
    expect(explainNotPlayable(counts({ total: 1, needsReview: 1 }))).toBe(
      "The question needs review before it can be practised.",
    );
    expect(explainNotPlayable(counts({ total: 4, noAnswer: 4 }))).toBe(
      "No questions with an answer yet.",
    );
    expect(explainNotPlayable(counts({ total: 2, excluded: 2 }))).toBe(
      "All questions are excluded from practice.",
    );
    expect(explainNotPlayable(counts({ total: 0 }))).toBe("This set has no questions yet.");
  });

  it("explains a mix", () => {
    expect(
      explainNotPlayable(counts({ total: 10, needsReview: 7, noAnswer: 1, excluded: 2 })),
    ).toBe(
      "None of the 10 questions can be practised yet: 7 need review, 1 has no answer yet, 2 excluded.",
    );
    expect(explainNotPlayable(counts({ total: 5, needsReview: 3, noAnswer: 2 }))).toBe(
      "None of the 5 questions can be practised yet: 3 need review, 2 have no answer yet.",
    );
  });
});

describe("filters and links", () => {
  it("parses the filter parameter, defaulting to all", () => {
    expect(parseFilter("needs-review")).toBe("needs-review");
    expect(parseFilter(["no-answer", "excluded"])).toBe("no-answer");
    expect(parseFilter("nonsense")).toBe("all");
    expect(parseFilter(undefined)).toBe("all");
  });

  it("matches a question to a filter using the same classes as the counts", () => {
    const review = q("active", "needs_review");
    expect(matchesFilter("all", review)).toBe(true);
    expect(matchesFilter("needs-review", review)).toBe(true);
    expect(matchesFilter("excluded", review)).toBe(false);
    expect(matchesFilter("no-answer", q("excluded", "unresolved", "unresolved"))).toBe(true);
    expect(matchesFilter("needs-review", q("active", "human_reviewed"))).toBe(false);
  });

  it("opens the most useful filter first and builds editor links", () => {
    const base = { total: 3, playable: 0, needsReview: 0, noAnswer: 0, excluded: 0 };
    expect(filterToFix({ ...base, needsReview: 1, noAnswer: 2 })).toBe("needs-review");
    expect(filterToFix({ ...base, noAnswer: 2 })).toBe("no-answer");
    expect(filterToFix({ ...base, excluded: 3 })).toBe("excluded");
    expect(filterToFix(base)).toBe("all");
    expect(editorHref("abc", "needs-review")).toBe("/question-sets/abc/edit?filter=needs-review");
    expect(editorHref("abc", "all")).toBe("/question-sets/abc/edit");
  });

  it("reads counts from error details and rejects anything else", () => {
    expect(
      countsFromDetails({ total: 3, playable: 0, needsReview: 2, noAnswer: 1, excluded: 0 }),
    ).toEqual({ total: 3, playable: 0, needsReview: 2, noAnswer: 1, excluded: 0 });
    expect(countsFromDetails({ total: "3" })).toBeNull();
    expect(countsFromDetails(null)).toBeNull();
    expect(countsFromDetails(undefined)).toBeNull();
  });
});
