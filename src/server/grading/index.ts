import type { AnswerKey, QuestionResponse } from "@/lib/schemas";
import { normalizeText, outputLines } from "./normalize";

export type GradingOutcome = "correct" | "incorrect" | "uncertain";

export type Gradable = {
  type: string;
  answerKey: AnswerKey;
};

const sameSet = (a: string[], b: string[]) => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
};

const equalLines = (a: string[], b: string[]) =>
  a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * Deterministic grading. Anything it cannot judge reliably (unknown question type, or a
 * response whose shape does not match the key) is "uncertain", never "incorrect".
 */
export function gradeResponse(question: Gradable, response: QuestionResponse): GradingOutcome {
  const key = question.answerKey;
  // No usable key (e.g. an imported question whose answer could not be determined): never guess.
  if (key.kind === "unresolved") return "uncertain";
  switch (question.type) {
    case "mcq_single":
    case "mcq_multi": {
      if (key.kind !== "options" || response.kind !== "options") return "uncertain";
      return sameSet(response.selectedOptionIds, key.correctOptionIds) ? "correct" : "incorrect";
    }
    case "short_answer": {
      if (key.kind !== "text" || response.kind !== "text") return "uncertain";
      const given = normalizeText(response.text, key.caseSensitive);
      return key.accepted.some((a) => normalizeText(a, key.caseSensitive) === given)
        ? "correct"
        : "incorrect";
    }
    case "fill_blank": {
      if (key.kind !== "blanks" || response.kind !== "blanks") return "uncertain";
      if (response.values.length !== key.blanks.length) return "incorrect";
      return key.blanks.every((accepted, i) => {
        const given = normalizeText(response.values[i] ?? "", key.caseSensitive);
        return accepted.some((a) => normalizeText(a, key.caseSensitive) === given);
      })
        ? "correct"
        : "incorrect";
    }
    case "output_prediction": {
      if (key.kind !== "text" || response.kind !== "text") return "uncertain";
      const given = outputLines(response.text, key.caseSensitive);
      return key.accepted.some((a) => equalLines(outputLines(a, key.caseSensitive), given))
        ? "correct"
        : "incorrect";
    }
    default:
      return "uncertain";
  }
}

/** The key as it may be shown to the student after they have submitted. */
export function revealAnswer(key: AnswerKey) {
  if (key.kind === "options")
    return { kind: "options" as const, correctOptionIds: key.correctOptionIds };
  if (key.kind === "unresolved") return { kind: "unresolved" as const };
  if (key.kind === "text") return { kind: "text" as const, accepted: key.accepted };
  return { kind: "blanks" as const, blanks: key.blanks };
}

export { normalizeText, outputLines };
