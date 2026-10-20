import { questionContentSchema } from "@/lib/schemas";
import type { OwnerQuestionView, QuestionType } from "@/lib/client/types";

export const TYPE_LABELS: Record<QuestionType, string> = {
  mcq_single: "Multiple choice (one answer)",
  mcq_multi: "Multiple choice (several answers)",
  short_answer: "Short answer",
  fill_blank: "Fill in the blanks",
  output_prediction: "Predict the output",
};

/** Editable form state. Everything is plain strings/arrays so it maps 1:1 onto form fields. */
export type QuestionDraft = {
  type: QuestionType;
  prompt: string;
  codeSnippet: string;
  explanation: string;
  options: { id: string; text: string }[];
  correctOptionIds: string[];
  accepted: string[];
  /** One entry per blank; alternatives for a blank are separated by " | " in the UI. */
  blanks: string[][];
  caseSensitive: boolean;
  approve: boolean;
};

export function nextOptionId(options: { id: string }[]): string {
  let n = options.length + 1;
  while (options.some((o) => o.id === `o${n}`)) n++;
  return `o${n}`;
}

export function emptyDraft(type: QuestionType = "mcq_single"): QuestionDraft {
  return {
    type,
    prompt: "",
    codeSnippet: "",
    explanation: "",
    options: [
      { id: "o1", text: "" },
      { id: "o2", text: "" },
    ],
    correctOptionIds: [],
    accepted: [""],
    blanks: [[""]],
    caseSensitive: type === "output_prediction",
    approve: true,
  };
}

export function draftFromQuestion(q: OwnerQuestionView): QuestionDraft {
  const base = emptyDraft(q.type);
  const draft: QuestionDraft = {
    ...base,
    type: q.type,
    prompt: q.prompt,
    codeSnippet: q.codeSnippet ?? "",
    explanation: q.explanation ?? "",
    options: q.options.length > 0 ? q.options : base.options,
    approve: q.evidenceStatus === "human_reviewed",
  };
  const key = q.answerKey;
  if (key.kind === "options") draft.correctOptionIds = key.correctOptionIds;
  if (key.kind === "text") {
    draft.accepted = key.accepted;
    draft.caseSensitive = key.caseSensitive;
  }
  if (key.kind === "blanks") {
    draft.blanks = key.blanks;
    draft.caseSensitive = key.caseSensitive;
  }
  return draft;
}

export function parseAlternatives(value: string): string[] {
  return value
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Switching type keeps the prompt and shared fields and fixes up answers that no longer fit. */
export function changeType(draft: QuestionDraft, type: QuestionType): QuestionDraft {
  const correct =
    type === "mcq_single" ? draft.correctOptionIds.slice(0, 1) : draft.correctOptionIds;
  return {
    ...draft,
    type,
    correctOptionIds: correct,
    caseSensitive: type === "output_prediction" ? true : draft.caseSensitive,
  };
}

export type DraftErrors = Partial<
  Record<"prompt" | "options" | "correctOptionIds" | "accepted" | "blanks" | "form", string>
>;

/** What the server's question schema receives (the same schema validates on the server). */
export function draftToInput(draft: QuestionDraft): Record<string, unknown> {
  const common = {
    type: draft.type,
    prompt: draft.prompt.trim(),
    codeSnippet: draft.codeSnippet.trim() === "" ? null : draft.codeSnippet,
    explanation: draft.explanation.trim() === "" ? null : draft.explanation.trim(),
  };
  if (draft.type === "mcq_single" || draft.type === "mcq_multi") {
    return {
      ...common,
      options: draft.options.map((o) => ({ id: o.id, text: o.text.trim() })),
      correctOptionIds: draft.correctOptionIds,
    };
  }
  if (draft.type === "fill_blank") {
    return {
      ...common,
      blanks: draft.blanks.map((alts) => alts.map((a) => a.trim()).filter(Boolean)),
      caseSensitive: draft.caseSensitive,
    };
  }
  return {
    ...common,
    accepted: draft.accepted.map((a) => a.trim()).filter(Boolean),
    caseSensitive: draft.caseSensitive,
  };
}

const FIELD_FOR_ROOT: Record<string, keyof DraftErrors> = {
  prompt: "prompt",
  options: "options",
  correctOptionIds: "correctOptionIds",
  accepted: "accepted",
  blanks: "blanks",
};

export function validateDraft(
  draft: QuestionDraft,
): { ok: true; input: Record<string, unknown> } | { ok: false; errors: DraftErrors } {
  const input = draftToInput(draft);
  const errors: DraftErrors = {};

  // Friendly messages for the common mistakes before falling back to the schema's wording.
  if (!draft.prompt.trim()) errors.prompt = "Write the question.";
  if (draft.type === "mcq_single" || draft.type === "mcq_multi") {
    if (draft.options.some((o) => !o.text.trim())) errors.options = "Every option needs text.";
    else if (draft.options.length < 2) errors.options = "Add at least two options.";
    if (draft.correctOptionIds.length === 0) {
      errors.correctOptionIds = "Choose the correct answer.";
    } else if (draft.type === "mcq_single" && draft.correctOptionIds.length !== 1) {
      errors.correctOptionIds = "Choose exactly one correct answer.";
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const parsed = questionContentSchema.safeParse(input);
  if (parsed.success) return { ok: true, input };
  for (const issue of parsed.error.issues) {
    const field = FIELD_FOR_ROOT[String(issue.path[0])] ?? "form";
    errors[field] ??= issue.message;
  }
  return { ok: false, errors };
}
