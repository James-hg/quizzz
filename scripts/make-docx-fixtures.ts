// Generates the DOCX fixtures used by the extractor tests. Content is original and small.
// Run: npm run fixtures:docx
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AlignmentType, Document, ImageRun, LevelFormat, Packer, Paragraph, TextRun } from "docx";

const OUT = join(process.cwd(), "fixtures", "docx");

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const numbering = {
  config: [
    {
      reference: "quiz",
      levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START },
        { level: 1, format: LevelFormat.UPPER_LETTER, text: "%2.", alignment: AlignmentType.START },
      ],
    },
    {
      reference: "bullets",
      levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.START }],
    },
  ],
};

const styles = {
  paragraphStyles: [
    { id: "AnswerStyle", name: "Answer Style", basedOn: "Normal", run: { bold: true } },
  ],
};

const plain = (text: string) => new Paragraph({ children: [new TextRun(text)] });
const question = (text: string) =>
  new Paragraph({ numbering: { reference: "quiz", level: 0 }, children: [new TextRun(text)] });
const option = (text: string, bold = false) =>
  new Paragraph({
    numbering: { reference: "quiz", level: 1 },
    children: [new TextRun({ text, bold })],
  });
const bullet = (text: string, bold = false) =>
  new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    children: [new TextRun({ text, bold })],
  });

const fixtures: Record<string, Paragraph[]> = {
  "numbered-list": [
    plain("Python basics quiz"),
    question("What does len([1, 2]) return?"),
    option("1"),
    option("2", true),
    option("3"),
    question("Which keyword defines a function in Python?"),
    option("def", true),
    option("func"),
    option("lambda"),
  ],
  "manual-numbering": [
    plain("1. What is 2 + 2?"),
    plain("A. 3"),
    new Paragraph({ children: [new TextRun({ text: "B. 4", bold: true })] }),
    plain("Question 2 Which loop always runs at least once?"),
    plain("A) for"),
    new Paragraph({ children: [new TextRun({ text: "B) do-while", bold: true })] }),
    plain("C) while"),
  ],
  "bullet-only": [
    plain("1. Which symbol starts a Python comment?"),
    bullet("#", true),
    bullet("//"),
    bullet("--"),
  ],
  "wrapped-option": [
    question("Which statement about Python lists is"),
    plain("true when the list is empty?"),
    option("len(x) is zero", true),
    new Paragraph({ children: [new TextRun({ text: "bool(x) is True and it", bold: true })] }),
    new Paragraph({ children: [new TextRun({ text: "has no items", bold: true })] }),
    option("x is None"),
  ],
  "partial-bold": [
    question("What does print(2 ** 3) output?"),
    option("It prints 6"),
    new Paragraph({
      numbering: { reference: "quiz", level: 1 },
      children: [new TextRun("It prints "), new TextRun({ text: "8", bold: true })],
    }),
    option("It prints 9"),
  ],
  "inherited-bold": [
    question("Which collection type is immutable?"),
    option("list"),
    new Paragraph({
      style: "AnswerStyle",
      numbering: { reference: "quiz", level: 1 },
      children: [new TextRun("tuple")],
    }),
    option("dict"),
  ],
  "missing-bold": [
    question("Which operator performs floor division in Python?"),
    option("/"),
    option("//"),
    option("%"),
  ],
  "multiple-bold": [
    question("Which of these are Python numeric types?"),
    option("int", true),
    option("float", true),
    option("str"),
  ],
  "image-in-question": [
    question("What does the diagram below show?"),
    new Paragraph({
      children: [
        new ImageRun({ type: "png", data: PNG_1X1, transformation: { width: 24, height: 24 } }),
      ],
    }),
    option("A stack", true),
    option("A queue"),
  ],
  "edge-cases": [
    option("An option with no question above it"),
    question("A question with a single option?"),
    option("Only choice", true),
  ],
};

mkdirSync(OUT, { recursive: true });
for (const [name, children] of Object.entries(fixtures)) {
  const doc = new Document({
    creator: "quizzz fixtures",
    title: name,
    numbering,
    styles,
    sections: [{ children }],
  });
  writeFileSync(join(OUT, `${name}.docx`), await Packer.toBuffer(doc));
  console.log(`wrote fixtures/docx/${name}.docx`);
}
