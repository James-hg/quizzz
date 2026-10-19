import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { detectMcqs, type DraftQuestion } from "@/server/import/mcq-detect";
import { registerDefaultExtractors } from "./defaults";
import { Corrupt, TooLarge, ZipBomb } from "./errors";
import { DEFAULT_LIMITS } from "./limits";
import { clearExtractors, runExtraction } from "./registry";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function fixture(name: string): Buffer {
  return readFileSync(join(process.cwd(), "fixtures", "docx", `${name}.docx`));
}

async function extract(name: string, limits = DEFAULT_LIMITS) {
  return runExtraction(fixture(name), { filename: `${name}.docx`, mimeType: DOCX_MIME }, limits);
}

async function draft(name: string) {
  return detectMcqs(await extract(name));
}

const summary = (q: DraftQuestion) => ({
  prompt: q.prompt,
  options: q.options.map((o) => [o.text, o.isCorrect]),
  status: q.answerStatus,
  type: q.suggestedType,
  warnings: q.warnings.map((w) => w.code),
});

beforeEach(() => {
  clearExtractors();
  registerDefaultExtractors();
});

describe("DOCX fixtures", () => {
  it("numbered-list: list levels become questions and options, with heading anchors", async () => {
    const result = await extract("numbered-list");
    expect(result.meta.format).toBe("docx");
    const d = detectMcqs(result);
    expect(d.preamble.map((b) => b.text)).toEqual(["Python basics quiz", "Week 1"]);
    expect(d.questions.map(summary)).toEqual([
      {
        prompt: "What does len([1, 2]) return?",
        options: [
          ["1", false],
          ["2", true],
          ["3", false],
        ],
        status: "resolved",
        type: "mcq_single",
        warnings: [],
      },
      {
        prompt: "Which keyword defines a function in Python?",
        options: [
          ["def", true],
          ["func", false],
          ["lambda", false],
        ],
        status: "resolved",
        type: "mcq_single",
        warnings: [],
      },
    ]);
    expect(d.questions[0]!.anchor).toMatchObject({
      type: "docx_paragraph",
      headingPath: ["Week 1"],
    });
    expect(result.blocks.find((b) => b.text === "Week 1")?.kind).toBe("heading");
    expect(result.blocks.find((b) => b.text === "def")).toMatchObject({
      kind: "list_item",
      listLevel: 1,
    });
  });

  it("manual-numbering: regex fallback strips prefixes and keeps bold across a prefix", async () => {
    const d = await draft("manual-numbering");
    expect(d.questions.map(summary)).toEqual([
      {
        prompt: "What is 2 + 2?",
        options: [
          ["3", false],
          ["4", true],
        ],
        status: "resolved",
        type: "mcq_single",
        warnings: [],
      },
      {
        prompt: "Which loop always runs at least once?",
        options: [
          ["for", false],
          ["do-while", true],
          ["while", false],
        ],
        status: "resolved",
        type: "mcq_single",
        warnings: [],
      },
    ]);
  });

  it("bullet-only: bullets under a numbered stem are options", async () => {
    const d = await draft("bullet-only");
    expect(d.questions.map(summary)).toEqual([
      {
        prompt: "Which symbol starts a Python comment?",
        options: [
          ["#", true],
          ["//", false],
          ["--", false],
        ],
        status: "resolved",
        type: "mcq_single",
        warnings: [],
      },
    ]);
  });

  it("wrapped-option: continuation lines join the previous stem or option", async () => {
    const d = await draft("wrapped-option");
    expect(d.questions.map(summary)).toEqual([
      {
        prompt: "Which statement about Python lists is true when the list is empty?",
        options: [
          ["len(x) is zero", false],
          ["bool(x) is True and it has no items", true],
          ["x is None", false],
        ],
        status: "resolved",
        type: "mcq_single",
        warnings: [],
      },
    ]);
  });

  it("partial-bold: flagged, and no answer is proposed", async () => {
    const q = (await draft("partial-bold")).questions[0]!;
    expect(summary(q)).toMatchObject({
      status: "ambiguous",
      warnings: ["partial_bold"],
    });
    expect(q.options.map((o) => o.isCorrect)).toEqual([false, false, false]);
  });

  it("inherited-bold: bold from a paragraph style counts", async () => {
    const q = (await draft("inherited-bold")).questions[0]!;
    expect(summary(q)).toEqual({
      prompt: "Which collection type is immutable?",
      options: [
        ["list", false],
        ["tuple", true],
        ["dict", false],
      ],
      status: "resolved",
      type: "mcq_single",
      warnings: [],
    });
  });

  it("missing-bold: the answer stays unresolved, never guessed", async () => {
    const q = (await draft("missing-bold")).questions[0]!;
    expect(summary(q)).toMatchObject({ status: "unresolved", warnings: ["no_bold_answer"] });
    expect(q.options.some((o) => o.isCorrect)).toBe(false);
  });

  it("multiple-bold: proposes mcq_multi but asks for confirmation", async () => {
    const q = (await draft("multiple-bold")).questions[0]!;
    expect(summary(q)).toMatchObject({
      type: "mcq_multi",
      status: "multi_proposed",
      warnings: ["multiple_bold_answers"],
    });
    expect(q.options.map((o) => o.isCorrect)).toEqual([true, true, false]);
  });

  it("image-in-question: records the asset and flags the dependency on that question", async () => {
    const result = await extract("image-in-question");
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({ mimeType: "image/png" });
    expect(result.assets[0]!.sizeBytes).toBeGreaterThan(0);
    const q = detectMcqs(result).questions[0]!;
    expect(q.warnings.map((w) => w.code)).toEqual(["image_dependency"]);
    expect(q.options.map((o) => o.isCorrect)).toEqual([true, false]);
  });

  it("edge-cases: orphan option and single-option question are reported", async () => {
    const d = await draft("edge-cases");
    expect(d.warnings.map((w) => w.code)).toEqual(["option_without_question"]);
    expect(d.questions.map(summary)).toEqual([
      {
        prompt: "A question with a single option?",
        options: [["Only choice", true]],
        status: "resolved",
        type: "mcq_single",
        warnings: ["too_few_options"],
      },
    ]);
  });

  it("is deterministic: the same file gives identical output", async () => {
    for (const name of ["numbered-list", "partial-bold", "image-in-question"]) {
      const a = await extract(name);
      const b = await extract(name);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(JSON.stringify(detectMcqs(a))).toBe(JSON.stringify(detectMcqs(b)));
    }
  });
});

describe("DOCX limits and hostile input", () => {
  const docxFile = (name = "numbered-list") => ({
    filename: `${name}.docx`,
    mimeType: DOCX_MIME,
  });

  it("rejects an oversized upload", async () => {
    await expect(
      runExtraction(fixture("numbered-list"), docxFile(), {
        ...DEFAULT_LIMITS,
        maxUploadBytes: 100,
      }),
    ).rejects.toBeInstanceOf(TooLarge);
  });

  it("rejects a document that expands past the ZIP limits", async () => {
    await expect(
      runExtraction(fixture("numbered-list"), docxFile(), {
        ...DEFAULT_LIMITS,
        maxZipTotalBytes: 500,
      }),
    ).rejects.toBeInstanceOf(ZipBomb);
    await expect(
      runExtraction(fixture("numbered-list"), docxFile(), { ...DEFAULT_LIMITS, maxZipEntries: 2 }),
    ).rejects.toBeInstanceOf(ZipBomb);
  });

  it("rejects a truncated file as corrupt", async () => {
    const cut = fixture("numbered-list").subarray(0, 300);
    await expect(runExtraction(cut, docxFile(), DEFAULT_LIMITS)).rejects.toBeInstanceOf(Corrupt);
  });

  it("rejects a ZIP that is not a Word document", async () => {
    const zip = Buffer.from(zipSync({ "hello.txt": new TextEncoder().encode("hi") }));
    await expect(runExtraction(zip, docxFile(), DEFAULT_LIMITS)).rejects.toBeInstanceOf(Corrupt);
  });

  it("refuses XML that declares a DTD or entities", async () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x "boom">]><w:document xmlns:w="w"><w:body/></w:document>`;
    const zip = Buffer.from(zipSync({ "word/document.xml": new TextEncoder().encode(xml) }));
    await expect(runExtraction(zip, docxFile(), DEFAULT_LIMITS)).rejects.toBeInstanceOf(Corrupt);
  });

  it("reports macros without running them", async () => {
    const original = fixture("numbered-list");
    const { unzipSync } = await import("fflate");
    const files = unzipSync(original);
    const zip = Buffer.from(
      zipSync({ ...files, "word/vbaProject.bin": new TextEncoder().encode("not real") }),
    );
    const result = await runExtraction(zip, docxFile(), DEFAULT_LIMITS);
    expect(result.warnings.map((w) => w.code)).toContain("macros_ignored");
  });
});
