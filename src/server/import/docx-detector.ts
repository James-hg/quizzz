import "server-only";
import type { ExtractAnchor, ExtractResult } from "@/lib/schemas";
import { detectMcqs } from "./mcq-detect";
import type { Detection, DetectedQuestion } from "./types";

function paragraphIndex(anchor: ExtractAnchor): number | undefined {
  return anchor.type === "docx_paragraph" ? anchor.index : undefined;
}

/**
 * Adapts the DOCX multiple-choice detector to the import pipeline. Every block from the stem
 * to the last option (including wrapped lines) becomes a source reference for the question.
 */
export function detectDocxQuestions(result: ExtractResult): Detection {
  const draft = detectMcqs(result);

  const questions = draft.questions.map((question): DetectedQuestion => {
    const indexes = [question.anchor, ...question.options.map((o) => o.anchor)]
      .map(paragraphIndex)
      .filter((index): index is number => index !== undefined);
    const first = Math.min(...indexes);
    const last = Math.max(...indexes);
    const blockIds = result.blocks
      .filter((block) => {
        const index = paragraphIndex(block.anchor);
        return index !== undefined && index >= first && index <= last;
      })
      .map((block) => block.id);
    return {
      prompt: question.prompt,
      options: question.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
      anchor: question.anchor,
      blockIds,
      warnings: question.warnings,
    };
  });
  return { questions, warnings: draft.warnings };
}
