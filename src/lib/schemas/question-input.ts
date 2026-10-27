import { z } from "zod";
import { questionImageInputSchema } from "@/lib/images";
import { optionSchema } from "./options";

const base = {
  prompt: z.string().trim().min(1).max(10_000),
  codeSnippet: z.string().max(20_000).nullish(),
  explanation: z.string().max(10_000).nullish(),
};

const optionList = z
  .array(optionSchema)
  .min(2, "needs at least 2 options")
  .max(10)
  .refine((options) => new Set(options.map((o) => o.id)).size === options.length, {
    message: "option ids must be unique",
  });

const nonEmptyAnswer = z.string().trim().min(1, "accepted answers cannot be empty");

function checkCorrectIds(
  value: { options: { id: string }[]; correctOptionIds: string[] },
  ctx: z.RefinementCtx,
  exactlyOne: boolean,
) {
  const ids = new Set(value.options.map((o) => o.id));
  const unique = new Set(value.correctOptionIds);
  if (unique.size !== value.correctOptionIds.length) {
    ctx.addIssue({ code: "custom", path: ["correctOptionIds"], message: "duplicate correct ids" });
  }
  if (!value.correctOptionIds.every((id) => ids.has(id))) {
    ctx.addIssue({
      code: "custom",
      path: ["correctOptionIds"],
      message: "correct ids must match option ids",
    });
  }
  if (exactlyOne && value.correctOptionIds.length !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["correctOptionIds"],
      message: "single-answer questions need exactly 1 correct option",
    });
  }
  if (!exactlyOne && value.correctOptionIds.length < 1) {
    ctx.addIssue({
      code: "custom",
      path: ["correctOptionIds"],
      message: "needs at least 1 correct option",
    });
  }
}

const mcqSingle = z
  .object({
    type: z.literal("mcq_single"),
    ...base,
    options: optionList,
    correctOptionIds: z.array(z.string().min(1)),
  })
  .superRefine((v, ctx) => checkCorrectIds(v, ctx, true));

const mcqMulti = z
  .object({
    type: z.literal("mcq_multi"),
    ...base,
    options: optionList,
    correctOptionIds: z.array(z.string().min(1)),
  })
  .superRefine((v, ctx) => checkCorrectIds(v, ctx, false));

// Program output is case sensitive by default ("True" and "true" differ in Python).
const textLike = (type: "short_answer" | "output_prediction", caseSensitiveDefault: boolean) =>
  z.object({
    type: z.literal(type),
    ...base,
    accepted: z.array(nonEmptyAnswer).min(1, "needs at least 1 accepted answer"),
    caseSensitive: z.boolean().default(caseSensitiveDefault),
  });

const fillBlank = z.object({
  type: z.literal("fill_blank"),
  ...base,
  blanks: z
    .array(z.array(nonEmptyAnswer).min(1, "each blank needs at least 1 accepted answer"))
    .min(1, "needs at least 1 blank"),
  caseSensitive: z.boolean().default(false),
});

/** Editor content for one question revision. */
export const questionContentSchema = z.discriminatedUnion("type", [
  mcqSingle,
  mcqMulti,
  textLike("short_answer", false),
  textLike("output_prediction", true),
  fillBlank,
]);

export type QuestionContent = z.infer<typeof questionContentSchema>;

/** Create: content plus an explicit owner approval, which is what marks it human-reviewed. */
export const createQuestionSchema = z.intersection(
  questionContentSchema,
  z.object({
    approve: z.boolean().default(false),
    /** An image already uploaded through `POST /api/question-sets/:id/images`. */
    image: questionImageInputSchema.optional(),
  }),
);

export type RevisionColumns = {
  type: QuestionContent["type"];
  prompt: string;
  codeSnippet: string | null;
  explanation: string | null;
  options: { id: string; text: string }[];
  answerKey:
    | { kind: "options"; correctOptionIds: string[] }
    | { kind: "text"; accepted: string[]; caseSensitive: boolean }
    | { kind: "blanks"; blanks: string[][]; caseSensitive: boolean }
    | { kind: "unresolved" };
};

/** Maps validated editor content onto question_revisions columns. */
export function contentToRevision(content: QuestionContent): RevisionColumns {
  const common = {
    type: content.type,
    prompt: content.prompt,
    codeSnippet: content.codeSnippet ?? null,
    explanation: content.explanation ?? null,
  };
  switch (content.type) {
    case "mcq_single":
    case "mcq_multi":
      return {
        ...common,
        options: content.options,
        answerKey: { kind: "options", correctOptionIds: content.correctOptionIds },
      };
    case "short_answer":
    case "output_prediction":
      return {
        ...common,
        options: [],
        answerKey: {
          kind: "text",
          accepted: content.accepted,
          caseSensitive: content.caseSensitive,
        },
      };
    case "fill_blank":
      return {
        ...common,
        options: [],
        answerKey: { kind: "blanks", blanks: content.blanks, caseSensitive: content.caseSensitive },
      };
  }
}

/** Inverse of contentToRevision, used to merge a partial PATCH over the current revision. */
export function revisionToContentInput(rev: RevisionColumns): Record<string, unknown> {
  const common = {
    type: rev.type,
    prompt: rev.prompt,
    codeSnippet: rev.codeSnippet,
    explanation: rev.explanation,
  };
  const key = rev.answerKey;
  if (key.kind === "options") {
    return { ...common, options: rev.options, correctOptionIds: key.correctOptionIds };
  }
  if (key.kind === "unresolved") {
    // The editor must supply the answer: validation fails until correctOptionIds is patched in.
    return { ...common, options: rev.options, correctOptionIds: [] };
  }
  if (key.kind === "text") {
    return { ...common, accepted: key.accepted, caseSensitive: key.caseSensitive };
  }
  return { ...common, blanks: key.blanks, caseSensitive: key.caseSensitive };
}

/** PATCH: any subset of content fields, merged over the current revision, then re-validated. */
export const patchQuestionSchema = z
  .object({
    type: z.enum(["mcq_single", "mcq_multi", "short_answer", "fill_blank", "output_prediction"]),
    prompt: z.string(),
    codeSnippet: z.string().nullable(),
    explanation: z.string().nullable(),
    options: z.array(optionSchema),
    correctOptionIds: z.array(z.string()),
    accepted: z.array(z.string()),
    blanks: z.array(z.array(z.string())),
    caseSensitive: z.boolean(),
    approve: z.boolean(),
    /** An image object replaces the image, `null` removes it, leaving it out keeps it. */
    image: questionImageInputSchema.nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "at least one field is required");

export type PatchQuestionInput = z.infer<typeof patchQuestionSchema>;
