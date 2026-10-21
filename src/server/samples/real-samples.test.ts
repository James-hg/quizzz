import { describe, expect, it } from "vitest";
import { contentToRevision } from "@/lib/schemas";
import type { QuestionResponse } from "@/lib/schemas";
import { gradeResponse } from "@/server/grading";
import { readSamples, resolveSamplesDir } from "./directory";

const { samples, problems } = await readSamples(resolveSamplesDir(process.env.SAMPLES_DIR));

function correctResponse(
  content: (typeof samples)[number]["course"]["questions"][number]["content"],
) {
  const key = contentToRevision(content).answerKey;
  if (key.kind === "options")
    return { kind: "options", selectedOptionIds: key.correctOptionIds } as QuestionResponse;
  if (key.kind === "text") return { kind: "text", text: key.accepted[0]! } as QuestionResponse;
  if (key.kind === "blanks")
    return { kind: "blanks", values: key.blanks.map((b) => b[0]!) } as QuestionResponse;
  throw new Error("sample questions must have an answer key");
}

describe("bundled sample courses", () => {
  it("have no problems", () => {
    expect(problems).toEqual([]);
  });

  for (const sample of samples) {
    describe(sample.course.course.language, () => {
      const questions = sample.course.questions;

      it("has at least 30 questions with unique ids and no duplicate questions", () => {
        expect(questions.length).toBeGreaterThanOrEqual(30);
        expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
        // Code questions share generic prompts, so uniqueness is prompt plus code.
        const text = (q: (typeof questions)[number]) =>
          `${q.content.prompt.trim()}\n${q.content.codeSnippet ?? ""}`;
        expect(new Set(questions.map(text)).size).toBe(questions.length);
      });

      it("grades every question's own answer as correct", () => {
        for (const q of questions) {
          const key = contentToRevision(q.content).answerKey;
          const outcome = gradeResponse(
            { type: q.content.type, answerKey: key },
            correctResponse(q.content),
          );
          expect(outcome, q.id).toBe("correct");
        }
      });

      it("grades a wrong multiple-choice answer as incorrect", () => {
        for (const q of questions) {
          const content = q.content;
          if (content.type !== "mcq_single" && content.type !== "mcq_multi") continue;
          const wrong = content.options
            .filter((o) => !content.correctOptionIds.includes(o.id))
            .map((o) => o.id);
          const outcome = gradeResponse(
            { type: q.content.type, answerKey: contentToRevision(q.content).answerKey },
            { kind: "options", selectedOptionIds: wrong.slice(0, 1) },
          );
          expect(outcome, q.id).toBe("incorrect");
        }
      });

      it("references only sections that exist", () => {
        const ids = new Set(sample.course.sections.map((s) => s.id));
        for (const q of questions)
          for (const s of q.sections) expect(ids.has(s), `${q.id} -> ${s}`).toBe(true);
      });

      it("does not claim to be checked unless a person added provenance", () => {
        // AI-drafted content ships without provenance, so it loads as "needs review".
        for (const q of questions) {
          if (q.provenance)
            expect(q.provenance.checkedBy).not.toMatch(/claude|ai|assistant|model/i);
        }
      });
    });
  }
});
