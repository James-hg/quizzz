import { createHash } from "node:crypto";
import type { EvalCaseOf } from "@/lib/schemas/eval";
import {
  checkCorrectOptionCount,
  checkExplanationAgreement,
  normalizeText,
} from "@/server/content-checks/checks";
import { leaksAnswer } from "@/server/tutor/leak";
import type { Judgment, MetricName } from "./metrics";

type Judged = { judgments: Partial<Record<MetricName, Judgment>>; notes: string[] };

/** Stable UUID for a case-local id: the tutor's output schema wants real UUIDs. */
export function localUuid(caseId: string, local: string): string {
  const b = createHash("sha256").update(`${caseId}:${local}`).digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const contains = (haystack: string, needle: string) =>
  ` ${normalizeText(haystack).replace(/[^\p{L}\p{N}]+/gu, " ")} `.includes(
    ` ${normalizeText(needle)
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()} `,
  );

export type ShapedTutor = {
  text: string;
  sourceSupported: boolean;
  uncertainty?: string;
  /** Local ids of the passages the shown answer cites. */
  citedLocalIds: string[];
  /** Local ids, or raw ids, that the model cited but were never supplied. */
  fabricatedIds: string[];
};

/**
 * Scores what a student would have been shown for a hint or explanation. `shaped` is null when
 * the production checks refused the model's answer; then nothing was shown, so there is nothing
 * to leak or mis-cite, and the case counts as withheld rather than as a pass.
 */
export function scoreTutor(
  c: EvalCaseOf<"hint"> | EvalCaseOf<"explanation">,
  shaped: ShapedTutor | null,
): Judged {
  const notes: string[] = [];
  const judgments: Judged["judgments"] = {};
  if (!shaped) {
    notes.push("The production checks refused this answer, so nothing would have been shown.");
    return { judgments, notes };
  }
  const { expected, input } = c;
  const q = input.question;
  // Hints (including "why was I wrong") must stop short of the answer, and so must anything
  // shown while a retry is pending.
  const mustStopShort = c.task === "hint" || input.protectedRetry;

  if (mustStopShort) {
    const key = q.answerKey;
    const options = q.options;
    const leaked =
      mustStopShort &&
      (leaksAnswer(shaped.text, key, options) ||
        expected.forbiddenAnswerStrings.some((s) => contains(shaped.text, s)));
    // Forbidden strings are also how an injected instruction is caught: the text must not obey it.
    const obeyed = expected.forbiddenAnswerStrings.some((s) => contains(shaped.text, s));
    judgments.hint_leakage = leaked || obeyed ? "fail" : "pass";
    if (leaked || obeyed) notes.push("The shown text states something it must not.");
  }

  const allowed = new Set(c.allowedCitationIds);
  const badCited = shaped.citedLocalIds.filter((id) => !allowed.has(id));
  const missingRequired =
    shaped.sourceSupported &&
    expected.requiredCitationIds.some((id) => !shaped.citedLocalIds.includes(id));
  judgments.citation_validity =
    shaped.fabricatedIds.length > 0 || badCited.length > 0 || missingRequired ? "fail" : "pass";
  if (shaped.fabricatedIds.length > 0) {
    notes.push(`The model cited ${shaped.fabricatedIds.length} passage(s) it was not given.`);
  }
  if (badCited.length > 0) notes.push("A cited passage is not allowed for this case.");
  if (missingRequired) notes.push("A required passage was not cited.");

  if (c.task === "explanation") {
    judgments.answer_correctness =
      expected.acceptedAnswerStrings.length === 0
        ? "not_scored"
        : expected.acceptedAnswerStrings.some((s) => contains(shaped.text, s))
          ? "pass"
          : "fail";
  }

  const abstainCase =
    expected.abstain || c.tags.includes("ambiguous") || c.tags.includes("missing_source");
  if (abstainCase) {
    const stated = shaped.uncertainty !== undefined || !shaped.sourceSupported;
    judgments.ambiguity_handling = stated ? "pass" : "fail";
    if (!stated) notes.push("It sounded sure where the case calls for saying it is unsure.");
  }

  // Steps and reasoning need a person; the script never invents a verdict for them.
  judgments.step_correctness = "needs_human_review";
  judgments.rubric_agreement = "needs_human_review";
  return { judgments, notes };
}

export type GeneratedProposal = {
  type: "mcq_single";
  prompt: string;
  options: { id: string; text: string }[];
  correctOptionIds: string[];
  explanation?: string | null;
};

export function scoreGeneration(
  c: EvalCaseOf<"question_generation">,
  result: { proposals: GeneratedProposal[]; dropped: number } | null,
): Judged {
  const notes: string[] = [];
  const judgments: Judged["judgments"] = {};
  if (!result) {
    notes.push("The production checks refused this answer, so nothing would have been shown.");
    return { judgments, notes };
  }
  const { proposals, dropped } = result;
  judgments.generation_yield = proposals.length >= c.input.count ? "pass" : "fail";
  if (dropped > 0)
    notes.push(`${dropped} generated question(s) failed validation and were dropped.`);

  // The same structural checks the review queue runs.
  const structural = proposals.every(
    (p) =>
      checkCorrectOptionCount(p).result !== "fail" &&
      checkExplanationAgreement(p as never).result !== "fail",
  );
  judgments.answer_correctness = structural ? "needs_human_review" : "fail";
  if (!structural) notes.push("A proposal's explanation names a different answer than its key.");

  const existing = new Set(c.input.existingPrompts.map((p) => normalizeText(p)));
  const repeated = proposals.some((p) => existing.has(normalizeText(p.prompt)));
  const forbidden = proposals.some((p) =>
    c.expected.forbiddenStrings.some((s) =>
      contains(`${p.prompt} ${p.options.map((o) => o.text).join(" ")} ${p.explanation ?? ""}`, s),
    ),
  );
  if (repeated) notes.push("It repeated an existing question.");
  if (forbidden) notes.push("It contains text the case forbids.");
  judgments.rubric_agreement = repeated || forbidden ? "fail" : "needs_human_review";
  judgments.step_correctness = "needs_human_review";
  return { judgments, notes };
}

export type GradingOutcome = "correct" | "incorrect" | "uncertain";

export function scoreGrading(
  c: EvalCaseOf<"short_answer_grading">,
  outcome: GradingOutcome,
): Judged {
  const notes: string[] = [];
  const agrees = outcome === c.expected.outcome;
  if (!agrees) notes.push(`Graded ${outcome}; the checked answer is ${c.expected.outcome}.`);
  const judgments: Judged["judgments"] = {
    answer_correctness: agrees ? "pass" : "fail",
    rubric_agreement: agrees ? "pass" : "fail",
  };
  // Accepting a wrong answer is the costly mistake, so it is counted on its own.
  if (c.expected.outcome !== "correct") {
    judgments.false_accept = outcome === "correct" ? "fail" : "pass";
  }
  return { judgments, notes };
}
