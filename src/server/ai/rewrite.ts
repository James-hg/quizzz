import "server-only";
import { z } from "zod";
import {
  checkProposal,
  hasNumbers,
  provenanceFor,
  warningsFor,
  type RewriteMode,
  type RewriteRequest,
} from "@/lib/rewrite";
import { questionContentSchema, type QuestionContent } from "@/lib/schemas";
import { loadOriginal } from "@/server/content/rewrites";
import type { Database } from "@/server/db";
import { ApiError } from "@/server/http/errors";
import { AiInvalidOutput } from "./errors";
import { DATA_NOT_INSTRUCTIONS, delimitData } from "./prompt";
import type { AiMessage, AiProvider } from "./provider";

export type RewriteProposal = {
  mode: RewriteMode;
  baseRevisionId: string;
  baseRevisionNumber: number;
  content: QuestionContent;
  origin: "ai_variant" | "ai_proposed";
  evidenceStatus: "generated_unreviewed" | "needs_review";
  /** Things the owner must check before accepting. */
  warnings: string[];
};

export type PreparedRewrite = Awaited<ReturnType<typeof prepareRewrite>>;

/**
 * Everything that can be refused without the model: the question must be the owner's and have an
 * answer, and "vary numbers" needs numbers. Runs before quota is charged.
 */
export async function prepareRewrite(
  db: Database,
  userId: string,
  questionId: string,
  mode: RewriteMode,
) {
  const { view, content } = await loadOriginal(db, userId, questionId);
  if (mode === "vary_numbers" && !hasNumbers(content)) {
    throw new ApiError(
      422,
      "no_numbers_to_vary",
      "This question has no numbers to change. Try rephrasing it instead.",
    );
  }
  return { view, original: content };
}

const text = (max: number) => z.string().trim().min(1).max(max);
const optionOut = z.object({ id: z.string().min(1).max(64), text: text(500) });

const rephraseOutput = z.object({
  prompt: text(10_000),
  /** Needed for multiple choice: every original option id with its new wording. */
  options: z.array(optionOut).max(10).optional(),
});

const explanationOutput = z.object({ explanation: text(2000) });

const varyOutput = z.object({
  prompt: text(10_000),
  codeSnippet: z.string().max(20_000).nullish(),
  explanation: z.string().max(10_000).nullish(),
  options: z.array(optionOut).max(10).optional(),
  correctOptionIds: z.array(z.string().min(1)).optional(),
  accepted: z.array(z.string().min(1)).optional(),
  blanks: z.array(z.array(z.string().min(1)).min(1)).optional(),
});

const isMcq = (c: QuestionContent) => c.type === "mcq_single" || c.type === "mcq_multi";

/** The question as data for the model. The answer is included so it can explain or re-derive. */
/** Room for the longest valid question, so the answer key is never cut off. */
const MAX_QUESTION_CHARS = 60_000;

function describe(original: QuestionContent) {
  const base = { type: original.type, prompt: original.prompt, code: original.codeSnippet ?? null };
  if (original.type === "mcq_single" || original.type === "mcq_multi") {
    return {
      ...base,
      options: original.options,
      correctOptionIds: original.correctOptionIds,
      explanation: original.explanation ?? null,
    };
  }
  if (original.type === "fill_blank") {
    return { ...base, blanks: original.blanks, explanation: original.explanation ?? null };
  }
  return { ...base, accepted: original.accepted, explanation: original.explanation ?? null };
}

function system(mode: RewriteMode, original: QuestionContent): string {
  const common = `You help a teacher improve a practice question for students. ${DATA_NOT_INSTRUCTIONS} `;
  switch (mode) {
    case "rephrase":
      return (
        common +
        "Rephrase the question text" +
        (isMcq(original)
          ? " and each option's wording, keeping every option id exactly as given. "
          : ". ") +
        "The meaning, every number, and the correct answer must stay exactly the same. " +
        "Do not add or remove options. Do not change any code."
      );
    case "add_explanation":
      return (
        common +
        "Write a short explanation (at most 3 sentences) of why the correct answer is correct, " +
        "for a student who got it wrong. Do not change the question."
      );
    case "vary_numbers":
      return (
        common +
        "Write a new version of this question with different numbers, so a student cannot reuse " +
        "the old answer. Keep the same type, topic and difficulty. Work out the new correct " +
        "answer yourself, step by step, and double-check it. Return the complete question " +
        "including its options and correct answer ids (or accepted answers). Update any code " +
        "that contains the numbers. Never reuse the old answer."
      );
  }
}

function guidance(mode: RewriteMode, original: QuestionContent): string {
  switch (mode) {
    case "rephrase":
      return isMcq(original)
        ? "Return { prompt, options: [{ id, text }] } with every original option id."
        : "Return { prompt }.";
    case "add_explanation":
      return "Return { explanation }.";
    case "vary_numbers":
      return isMcq(original)
        ? "Return { prompt, codeSnippet?, options: [{ id, text }], correctOptionIds, explanation? }."
        : original.type === "fill_blank"
          ? "Return { prompt, codeSnippet?, blanks: [[accepted answers for each blank]], explanation? }."
          : "Return { prompt, codeSnippet?, accepted: [accepted answers], explanation? }.";
  }
}

/** Builds a candidate question from the model's reply. May be invalid: it is checked next. */
function assemble(
  mode: RewriteMode,
  original: QuestionContent,
  raw: unknown,
): QuestionContent | null {
  if (mode === "add_explanation") {
    const out = explanationOutput.parse(raw);
    return { ...original, explanation: out.explanation };
  }
  if (mode === "rephrase") {
    const out = rephraseOutput.parse(raw);
    if (original.type === "mcq_single" || original.type === "mcq_multi") {
      const byId = new Map((out.options ?? []).map((o) => [o.id, o.text]));
      if (byId.size !== original.options.length) return null;
      if (!original.options.every((o) => byId.has(o.id))) return null;
      return {
        ...original,
        prompt: out.prompt,
        options: original.options.map((o) => ({ id: o.id, text: byId.get(o.id)! })),
      };
    }
    return { ...original, prompt: out.prompt };
  }
  const out = varyOutput.parse(raw);
  const shared = {
    prompt: out.prompt,
    codeSnippet: out.codeSnippet === undefined ? original.codeSnippet : out.codeSnippet,
    // The old explanation describes the old numbers, so it is not carried over.
    explanation: out.explanation ?? null,
  };
  if (original.type === "mcq_single" || original.type === "mcq_multi") {
    return {
      type: original.type,
      ...shared,
      options: out.options ?? [],
      correctOptionIds: out.correctOptionIds ?? [],
    };
  }
  if (original.type === "fill_blank") {
    return {
      type: "fill_blank",
      ...shared,
      blanks: out.blanks ?? [],
      caseSensitive: original.caseSensitive,
    };
  }
  return {
    type: original.type,
    ...shared,
    accepted: out.accepted ?? [],
    caseSensitive: original.caseSensitive,
  };
}

const outputSchemas = {
  rephrase: rephraseOutput,
  add_explanation: explanationOutput,
  vary_numbers: varyOutput,
} as const;

/**
 * Asks the model for a rewrite and returns it as a proposal. Nothing is saved. The reply must pass
 * the question schema and the rules of its mode; one retry tells the model what was wrong, and
 * after that the result is `ai_invalid_output`.
 */
export async function generateRewrite(
  provider: AiProvider,
  prepared: PreparedRewrite,
  request: RewriteRequest,
): Promise<RewriteProposal> {
  const { view, original } = prepared;
  const { mode } = request;
  const prompt = [
    `${guidance(mode, original)}`,
    delimitData("question", JSON.stringify(describe(original), null, 2), MAX_QUESTION_CHARS),
    request.hint ? `Teacher's guidance:\n${delimitData("guidance", request.hint, 300)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const options = {
    system: system(mode, original),
    maxOutputTokens: 1500,
    temperature: mode === "add_explanation" ? 0.3 : 0.6,
  };

  const messages: AiMessage[] = [{ role: "user", content: prompt }];
  let reason = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const schema: z.ZodType<unknown> = outputSchemas[mode];
    const raw = await provider.generateStructured(messages, schema, options);
    const candidate = assemble(mode, original, raw);
    const parsed = candidate ? questionContentSchema.safeParse(candidate) : null;
    const problem = !parsed
      ? "the option ids did not match the original"
      : !parsed.success
        ? (parsed.error.issues[0]?.message ?? "the question was not valid")
        : checkProposal(mode, original, parsed.data);
    if (parsed?.success && !problem) {
      return {
        mode,
        baseRevisionId: view.revisionId,
        baseRevisionNumber: view.revisionNumber,
        content: parsed.data,
        ...provenanceFor(mode),
        warnings: warningsFor(mode),
      };
    }
    reason = problem ?? "the reply was not usable";
    messages.push(
      { role: "assistant", content: JSON.stringify(raw).slice(0, 2000) },
      {
        role: "user",
        content: `That was not acceptable: ${reason}. Reply again with only the corrected JSON.`,
      },
    );
  }
  throw new AiInvalidOutput();
}
