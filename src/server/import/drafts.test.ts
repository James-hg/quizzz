import { describe, expect, it } from "vitest";
import type { ExtractResult } from "@/lib/schemas";
import { buildDraftItems } from "./drafts";
import type { DetectedQuestion } from "./types";

const anchor = (index: number) => ({ type: "docx_paragraph" as const, index, headingPath: [] });
const result: ExtractResult = {
  blocks: [0, 1, 2, 3].map((i) => ({
    id: `b${i}`,
    kind: "paragraph" as const,
    text: `block ${i}`,
    anchor: anchor(i),
  })),
  assets: [],
  warnings: [],
  meta: { format: "t" },
};

const q = (overrides: Partial<DetectedQuestion> = {}): DetectedQuestion => ({
  prompt: "Stem",
  options: [
    { text: "A", isCorrect: false },
    { text: "B", isCorrect: true },
  ],
  anchor: anchor(0),
  blockIds: ["b0", "b1", "b2"],
  warnings: [],
  ...overrides,
});

describe("buildDraftItems", () => {
  it("maps one marked option to mcq_single with letter ids and source refs", () => {
    const { items, warnings } = buildDraftItems(result, [q()]);
    expect(warnings).toEqual([]);
    expect(items[0]?.payload).toMatchObject({
      type: "mcq_single",
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      correctOptionIds: ["b"],
    });
    expect(items[0]?.sourceRefs).toEqual([{ ordinal: 0 }, { ordinal: 1 }, { ordinal: 2 }]);
    expect(items[0]?.itemWarnings).toEqual([]);
  });

  it("never guesses: no marked option is unresolved with a warning", () => {
    const { items } = buildDraftItems(result, [
      q({
        options: [
          { text: "A", isCorrect: false },
          { text: "B", isCorrect: false },
        ],
      }),
    ]);
    expect(items[0]?.payload).toMatchObject({ correctOptionIds: [] });
    expect(items[0]?.itemWarnings?.map((w) => w.code)).toContain("answer_unresolved");
  });

  it("proposes mcq_multi when several options are marked", () => {
    const { items } = buildDraftItems(result, [
      q({
        options: [
          { text: "A", isCorrect: true },
          { text: "B", isCorrect: true },
        ],
      }),
    ]);
    expect(items[0]?.payload).toMatchObject({ type: "mcq_multi", correctOptionIds: ["a", "b"] });
  });

  it("keeps detector warnings and skips malformed questions with a draft warning", () => {
    const withWarning = q({ warnings: [{ code: "partial_bold", message: "Check this" }] });
    const broken = q({ options: [{ text: "Only one", isCorrect: false }] });
    const { items, warnings } = buildDraftItems(result, [withWarning, broken]);
    expect(items).toHaveLength(1);
    expect(items[0]?.itemWarnings?.map((w) => w.code)).toEqual(["partial_bold"]);
    expect(warnings.map((w) => w.code)).toEqual(["question_skipped"]);
  });

  it("falls back to the anchor block when the detector gives no block ids", () => {
    const { items } = buildDraftItems(result, [q({ blockIds: undefined, anchor: anchor(2) })]);
    expect(items[0]?.sourceRefs).toEqual([{ ordinal: 2 }]);
  });
});
