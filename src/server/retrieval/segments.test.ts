import { describe, expect, it } from "vitest";
import { locationOf, queryTerms } from "./segments";

describe("locationOf", () => {
  it.each([
    [{ page: 3 }, "page 3"],
    [{ slide: 2 }, "slide 2"],
    [{ paragraphIndex: 0 }, "paragraph 1"],
    [
      { paragraphIndex: 9, headingPath: ["Week 1", "Loops"] },
      'paragraph 10, under "Week 1 > Loops"',
    ],
    [{ headingPath: ["Intro"] }, 'under "Intro"'],
    [{ page: 2, paragraphIndex: 1 }, "page 2, paragraph 2"],
  ])("labels %j as %s", (anchor, label) => {
    expect(locationOf(anchor)).toBe(label);
  });

  it("never invents a page for a paragraph-only anchor", () => {
    expect(locationOf({ paragraphIndex: 4 })).not.toMatch(/page|slide/);
  });
});

describe("queryTerms", () => {
  it("keeps distinct lowercase words and drops punctuation and search syntax", () => {
    expect(queryTerms("What is a Closure? closure & (scope) | !x :*")).toEqual([
      "what",
      "is",
      "a",
      "closure",
      "scope",
      "x",
    ]);
  });

  it("keeps non-English letters and digits", () => {
    expect(queryTerms("naïve café 2024")).toEqual(["naïve", "café", "2024"]);
  });

  it("is empty for blank or punctuation-only input and caps the number of words", () => {
    expect(queryTerms("  ?!. ")).toEqual([]);
    expect(queryTerms(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" "))).toHaveLength(12);
  });
});
