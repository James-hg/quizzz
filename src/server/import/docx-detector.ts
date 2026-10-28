import "server-only";
import type { ExtractAnchor, ExtractResult } from "@/lib/schemas";
import { IMAGE_MIME_TYPES } from "@/lib/images";
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

  const rangeOf = (question: (typeof draft.questions)[number]) => {
    const indexes = [question.anchor, ...question.options.map((o) => o.anchor)]
      .map(paragraphIndex)
      .filter((index): index is number => index !== undefined);
    return { first: Math.min(...indexes), last: Math.max(...indexes) };
  };
  const firsts = draft.questions.map((q) => rangeOf(q).first);

  const questions = draft.questions.map((question, i): DetectedQuestion => {
    const { first, last } = rangeOf(question);
    // Images between this question's start and the next question's start belong to it.
    const nextFirst = firsts[i + 1] ?? Number.POSITIVE_INFINITY;
    const ownAssets = result.assets.filter((asset) => {
      const index = asset.anchor ? paragraphIndex(asset.anchor) : undefined;
      return index !== undefined && index >= first && index < nextFirst;
    });
    const usable = ownAssets.find(
      (asset) =>
        asset.entryName && (IMAGE_MIME_TYPES as readonly string[]).includes(asset.mimeType),
    );
    const blockIds = result.blocks
      .filter((block) => {
        const index = paragraphIndex(block.anchor);
        return index !== undefined && index >= first && index <= last;
      })
      .map((block) => block.id);
    return {
      prompt: question.prompt,
      originalPrompt: question.originalPrompt,
      options: question.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
      anchor: question.anchor,
      blockIds,
      warnings: question.warnings,
      ...(usable ? { imageAssetId: usable.id } : {}),
      ...(ownAssets.length > (usable ? 1 : 0) && usable
        ? { extraImages: ownAssets.length - 1 }
        : {}),
    };
  });
  return { questions, warnings: draft.warnings };
}
