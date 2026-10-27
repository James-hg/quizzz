import type { Block, ExtractAnchor, ExtractResult, Warning } from "@/server/extract/types";

/**
 * Turns extractor blocks into a draft of multiple-choice questions. Pure and deterministic.
 * Ported from the legacy Python importer, with stricter handling of bold: a correct answer is
 * only ever proposed from clear signals, and anything else is flagged for the owner to resolve.
 */

// Regex fallbacks for manual numbering/lettering (same as the legacy importer).
export const QUESTION_PREFIX = /^(question\s*\d+|q\s*\d+|\d+[.)])\s+/i;
export const OPTION_PREFIX = /^([A-Ha-h][.)])\s+/i;

export type AnswerStatus =
  /** Exactly one fully bold option and no partial bold: a confident key. */
  | "resolved"
  /** Two or more fully bold options: probably multi-answer, owner must confirm. */
  | "multi_proposed"
  /** Nothing is bold. Never guessed. */
  | "unresolved"
  /** Some option is only partly bold: no key is proposed. */
  | "ambiguous";

export type DraftOption = { text: string; isCorrect: boolean; anchor: ExtractAnchor };

export type DraftQuestion = {
  prompt: string;
  /** The stem as written, when a leading number was removed from `prompt`. */
  originalPrompt?: string;
  options: DraftOption[];
  suggestedType: "mcq_single" | "mcq_multi";
  answerStatus: AnswerStatus;
  anchor: ExtractAnchor;
  warnings: Warning[];
};

export type McqDraft = {
  /** Text before the first question (titles, instructions). Kept, not a warning. */
  preamble: Block[];
  questions: DraftQuestion[];
  /** Problems not tied to one question, e.g. an option before any question. */
  warnings: Warning[];
};

type Kind = "question" | "option" | "other";

/** Text plus a per-character bold flag, so prefixes can be stripped without losing bold info. */
type Styled = { text: string; bold: boolean[] };

function styledFrom(block: Block): Styled {
  if (!block.runs || block.runs.length === 0) {
    return { text: block.text, bold: Array.from(block.text, () => false) };
  }
  let text = "";
  const bold: boolean[] = [];
  for (const run of block.runs) {
    for (const ch of run.text) {
      text += ch;
      bold.push(Boolean(run.bold));
    }
  }
  return { text, bold };
}

function trimStyled(s: Styled): Styled {
  const chars = Array.from(s.text);
  let start = 0;
  let end = chars.length;
  while (start < end && /\s/.test(chars[start]!)) start++;
  while (end > start && /\s/.test(chars[end - 1]!)) end--;
  return { text: chars.slice(start, end).join(""), bold: s.bold.slice(start, end) };
}

function stripPrefix(s: Styled, pattern: RegExp): Styled {
  const match = pattern.exec(s.text);
  if (!match) return s;
  const removed = Array.from(match[0]).length;
  return trimStyled({
    text: Array.from(s.text).slice(removed).join(""),
    bold: s.bold.slice(removed),
  });
}

function append(a: Styled, b: Styled): Styled {
  return { text: `${a.text} ${b.text}`, bold: [...a.bold, false, ...b.bold] };
}

type Coverage = "none" | "partial" | "full";

/** Whitespace is ignored: only visible characters decide whether an option is bold. */
function boldCoverage(s: Styled): Coverage {
  let visible = 0;
  let bold = 0;
  Array.from(s.text).forEach((ch, i) => {
    if (/\s/.test(ch)) return;
    visible++;
    if (s.bold[i]) bold++;
  });
  if (visible === 0 || bold === 0) return "none";
  return bold === visible ? "full" : "partial";
}

function classify(block: Block, text: string): { kind: Kind; styled: Styled } {
  const styled = trimStyled(styledFrom(block));
  const level = block.listLevel;
  if (level === 0) return { kind: "question", styled };
  if (level === 1) return { kind: "option", styled };
  if (QUESTION_PREFIX.test(text))
    return { kind: "question", styled: stripPrefix(styled, QUESTION_PREFIX) };
  if (OPTION_PREFIX.test(text))
    return { kind: "option", styled: stripPrefix(styled, OPTION_PREFIX) };
  return { kind: "other", styled };
}

type OpenOption = { styled: Styled; anchor: ExtractAnchor; index: number };
type OpenQuestion = {
  stem: Styled;
  stemRaw: string;
  /** The stem exactly as typed (before a leading number was stripped), wrapped lines included. */
  original: string;
  anchor: ExtractAnchor;
  firstIndex: number;
  options: OpenOption[];
};

function anchorIndex(anchor: ExtractAnchor): number | undefined {
  return anchor.type === "docx_paragraph" ? anchor.index : undefined;
}

export function detectMcqs(extract: ExtractResult): McqDraft {
  const preamble: Block[] = [];
  const warnings: Warning[] = [];
  const open: OpenQuestion[] = [];
  let current: OpenQuestion | undefined;
  let last: "question" | "option" | "none" = "none";

  for (const block of extract.blocks) {
    const text = block.text.trim();
    if (text === "") continue;

    // Headings are section titles: they never become part of a question or option.
    if (block.kind === "heading") {
      if (!current) preamble.push(block);
      last = "none";
      continue;
    }

    const classified = classify(block, text);
    const styled = classified.styled;
    let kind = classified.kind;

    // Bullet-only lists: a "question" that has no "?" and no numbering, seen while a question
    // is open, is really another option.
    if (kind === "question" && current) {
      const looksLikeQuestion = text.includes("?") || QUESTION_PREFIX.test(text);
      if (!looksLikeQuestion) kind = "option";
    }

    if (kind === "question") {
      current = {
        stem: styled,
        stemRaw: styled.text,
        original: trimStyled(styledFrom(block)).text,
        anchor: block.anchor,
        firstIndex: anchorIndex(block.anchor) ?? 0,
        options: [],
      };
      open.push(current);
      last = "question";
    } else if (kind === "option") {
      if (!current) {
        warnings.push({
          code: "option_without_question",
          message: `Option without a question: ${styled.text.slice(0, 40)}`,
          anchor: block.anchor,
        });
        continue;
      }
      current.options.push({
        styled,
        anchor: block.anchor,
        index: anchorIndex(block.anchor) ?? 0,
      });
      last = "option";
    } else {
      if (!current) {
        preamble.push(block);
        continue;
      }
      // A line that starts neither a question nor an option wraps the previous item.
      const lastOption = current.options[current.options.length - 1];
      if (last === "option" && lastOption) lastOption.styled = append(lastOption.styled, styled);
      else {
        current.stem = append(current.stem, styled);
        current.original = `${current.original} ${styled.text}`;
      }
    }
  }

  const imageWarnings = extract.warnings.filter((w) => w.code === "image_dependency");

  const questions = open.map((q, i): DraftQuestion => {
    const nextFirst = open[i + 1]?.firstIndex ?? Number.POSITIVE_INFINITY;
    const own: Warning[] = [];

    const coverage = q.options.map((o) => boldCoverage(o.styled));
    const full = coverage.filter((c) => c === "full").length;
    const partial = coverage.filter((c) => c === "partial").length;

    let answerStatus: AnswerStatus;
    if (partial > 0) answerStatus = "ambiguous";
    else if (full === 0) answerStatus = "unresolved";
    else if (full === 1) answerStatus = "resolved";
    else answerStatus = "multi_proposed";

    if (q.options.length < 2) {
      own.push({
        code: "too_few_options",
        message: "This question has fewer than 2 options.",
        anchor: q.anchor,
      });
    }
    if (partial > 0) {
      own.push({
        code: "partial_bold",
        message:
          "Only part of an option is bold, so no answer was chosen. Pick the correct option.",
        anchor: q.anchor,
      });
    }
    if (answerStatus === "unresolved") {
      own.push({
        code: "no_bold_answer",
        message: "No option is bold, so the correct answer is unresolved.",
        anchor: q.anchor,
      });
    }
    if (answerStatus === "multi_proposed") {
      own.push({
        code: "multiple_bold_answers",
        message:
          "More than one option is bold. This may be a multiple-answer question; confirm it.",
        anchor: q.anchor,
      });
    }
    if (boldCoverage(q.stem) !== "none") {
      own.push({
        code: "bold_in_stem",
        message:
          "The question text contains bold formatting; check that it is not an answer marker.",
        anchor: q.anchor,
      });
    }
    for (const w of imageWarnings) {
      const index = w.anchor ? anchorIndex(w.anchor) : undefined;
      if (index !== undefined && index >= q.firstIndex && index < nextFirst) own.push(w);
    }

    const confident = answerStatus === "resolved" || answerStatus === "multi_proposed";
    return {
      prompt: q.stem.text,
      ...(q.original !== q.stem.text ? { originalPrompt: q.original } : {}),
      options: q.options.map((o, j) => ({
        text: o.styled.text,
        isCorrect: confident && coverage[j] === "full",
        anchor: o.anchor,
      })),
      suggestedType: answerStatus === "multi_proposed" ? "mcq_multi" : "mcq_single",
      answerStatus,
      anchor: q.anchor,
      warnings: own,
    };
  });

  return { preamble, questions, warnings };
}
