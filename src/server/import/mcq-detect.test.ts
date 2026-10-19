import { describe, expect, it } from "vitest";
import type { Block, ExtractResult, TextRun } from "@/server/extract/types";
import { detectMcqs } from "./mcq-detect";

let counter = 0;
function block(
  text: string | TextRun[],
  opts: { level?: number; kind?: Block["kind"] } = {},
): Block {
  const index = counter++;
  const runs = typeof text === "string" ? [{ text }] : text;
  return {
    id: `p${index}`,
    kind: opts.kind ?? (opts.level === undefined ? "paragraph" : "list_item"),
    text: runs.map((r) => r.text).join(""),
    runs,
    ...(opts.level === undefined ? {} : { listLevel: opts.level }),
    anchor: { type: "docx_paragraph", index, headingPath: [] },
  };
}

const bold = (text: string): TextRun[] => [{ text, bold: true }];

function extract(blocks: Block[], warnings: ExtractResult["warnings"] = []): ExtractResult {
  return { blocks, assets: [], warnings, meta: { format: "docx" } };
}

describe("detectMcqs", () => {
  it("reads list levels: level 0 is a question and level 1 an option", () => {
    counter = 0;
    const draft = detectMcqs(
      extract([
        block("Title paragraph"),
        block("What is 1 + 1?", { level: 0 }),
        block("1", { level: 1 }),
        block(bold("2"), { level: 1 }),
      ]),
    );
    expect(draft.preamble.map((b) => b.text)).toEqual(["Title paragraph"]);
    expect(draft.questions).toHaveLength(1);
    const q = draft.questions[0]!;
    expect(q.prompt).toBe("What is 1 + 1?");
    expect(q.options.map((o) => [o.text, o.isCorrect])).toEqual([
      ["1", false],
      ["2", true],
    ]);
    expect(q.answerStatus).toBe("resolved");
    expect(q.warnings).toEqual([]);
  });

  it("falls back to regexes and strips prefixes", () => {
    counter = 0;
    const draft = detectMcqs(
      extract([
        block("1. What is 2 + 2?"),
        block("A. 3"),
        block([
          { text: "B. ", bold: false },
          { text: "4", bold: true },
        ]),
        block("Question 2 Pick one"),
        block("a) x"),
        block("b) y"),
      ]),
    );
    expect(draft.questions.map((q) => q.prompt)).toEqual(["What is 2 + 2?", "Pick one"]);
    const first = draft.questions[0]!;
    expect(first.options.map((o) => o.text)).toEqual(["3", "4"]);
    // The bold run is the whole option text once the "B. " prefix is stripped.
    expect(first.options[1]!.isCorrect).toBe(true);
  });

  it("treats a numberless, questionless 'question' as an option in bullet-only lists", () => {
    counter = 0;
    const draft = detectMcqs(
      extract([
        block("1. Which starts a comment?"),
        block(bold("#"), { level: 0 }),
        block("//", { level: 0 }),
      ]),
    );
    expect(draft.questions).toHaveLength(1);
    expect(draft.questions[0]!.options.map((o) => o.text)).toEqual(["#", "//"]);
    expect(draft.questions[0]!.options[0]!.isCorrect).toBe(true);
  });

  it("appends wrapped lines to the previous option or the question stem", () => {
    counter = 0;
    const draft = detectMcqs(
      extract([
        block("Which is", { level: 0 }),
        block("true?"),
        block(bold("first part"), { level: 1 }),
        block(bold("second part")),
        block("other", { level: 1 }),
      ]),
    );
    const q = draft.questions[0]!;
    expect(q.prompt).toBe("Which is true?");
    expect(q.options[0]!.text).toBe("first part second part");
    expect(q.options[0]!.isCorrect).toBe(true);
  });

  it("flags partial bold and proposes no answer", () => {
    counter = 0;
    const draft = detectMcqs(
      extract([
        block("Q?", { level: 0 }),
        block("It prints 6", { level: 1 }),
        block([{ text: "It prints " }, { text: "8", bold: true }], { level: 1 }),
      ]),
    );
    const q = draft.questions[0]!;
    expect(q.answerStatus).toBe("ambiguous");
    expect(q.options.some((o) => o.isCorrect)).toBe(false);
    expect(q.warnings.map((w) => w.code)).toContain("partial_bold");
  });

  it("leaves the answer unresolved when nothing is bold", () => {
    counter = 0;
    const draft = detectMcqs(
      extract([block("Q?", { level: 0 }), block("a", { level: 1 }), block("b", { level: 1 })]),
    );
    const q = draft.questions[0]!;
    expect(q.answerStatus).toBe("unresolved");
    expect(q.options.some((o) => o.isCorrect)).toBe(false);
    expect(q.warnings.map((w) => w.code)).toEqual(["no_bold_answer"]);
  });

  it("proposes mcq_multi when several options are fully bold", () => {
    counter = 0;
    const draft = detectMcqs(
      extract([
        block("Q?", { level: 0 }),
        block(bold("a"), { level: 1 }),
        block(bold("b"), { level: 1 }),
        block("c", { level: 1 }),
      ]),
    );
    const q = draft.questions[0]!;
    expect(q.suggestedType).toBe("mcq_multi");
    expect(q.answerStatus).toBe("multi_proposed");
    expect(q.options.map((o) => o.isCorrect)).toEqual([true, true, false]);
    expect(q.warnings.map((w) => w.code)).toContain("multiple_bold_answers");
  });

  it("warns about bold in the stem, too few options, and options before a question", () => {
    counter = 0;
    const draft = detectMcqs(
      extract([
        block("Orphan option", { level: 1 }),
        block(bold("Bold stem?"), { level: 0 }),
        block(bold("only"), { level: 1 }),
      ]),
    );
    expect(draft.warnings.map((w) => w.code)).toEqual(["option_without_question"]);
    const codes = draft.questions[0]!.warnings.map((w) => w.code);
    expect(codes).toContain("too_few_options");
    expect(codes).toContain("bold_in_stem");
  });

  it("attaches image warnings to the question they fall inside", () => {
    counter = 0;
    const blocks = [
      block("Q1?", { level: 0 }),
      block("a", { level: 1 }),
      block("Q2?", { level: 0 }),
      block("b", { level: 1 }),
    ];
    const image = {
      code: "image_dependency",
      message: "image",
      anchor: { type: "docx_paragraph" as const, index: 2, headingPath: [] },
    };
    // Index 2 is Q2's own paragraph, so the warning belongs to Q2 and not Q1.
    const draft = detectMcqs(extract(blocks, [image]));
    expect(draft.questions[0]!.warnings.map((w) => w.code)).not.toContain("image_dependency");
    expect(draft.questions[1]!.warnings.map((w) => w.code)).toContain("image_dependency");
  });

  it("ignores headings and is deterministic", () => {
    counter = 0;
    const blocks = [
      block("Week 1", { kind: "heading" }),
      block("Q?", { level: 0 }),
      block(bold("a"), { level: 1 }),
      block("b", { level: 1 }),
    ];
    const a = detectMcqs(extract(blocks));
    const b = detectMcqs(extract(blocks));
    expect(a).toEqual(b);
    expect(a.preamble.map((x) => x.text)).toEqual(["Week 1"]);
    expect(a.questions[0]!.prompt).toBe("Q?");
  });
});
