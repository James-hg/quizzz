import { z } from "zod";
import { extractAnchorSchema } from "./extract";
import { optionSchema } from "./options";

export const importWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  anchor: extractAnchorSchema.optional(),
});
export type ImportWarning = z.infer<typeof importWarningSchema>;

/** A detected multiple-choice question. `correctOptionIds` is empty when the answer is unknown. */
export const draftQuestionPayloadSchema = z
  .object({
    kind: z.literal("question"),
    type: z.enum(["mcq_single", "mcq_multi"]),
    prompt: z.string().trim().min(1).max(10_000),
    /**
     * The prompt as written in the document, kept when a leading question number was removed so
     * the review page can put it back. Publishing ignores it.
     */
    originalPrompt: z.string().max(10_000).nullish(),
    codeSnippet: z.string().max(20_000).nullish(),
    explanation: z.string().max(10_000).nullish(),
    options: z.array(optionSchema).min(2).max(10),
    correctOptionIds: z.array(z.string().min(1)),
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.options.map((o) => o.id));
    if (ids.size !== value.options.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "option ids must be unique" });
    }
    if (new Set(value.correctOptionIds).size !== value.correctOptionIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["correctOptionIds"],
        message: "duplicate correct ids",
      });
    }
    if (!value.correctOptionIds.every((id) => ids.has(id))) {
      ctx.addIssue({
        code: "custom",
        path: ["correctOptionIds"],
        message: "correct ids must match option ids",
      });
    }
    if (value.type === "mcq_single" && value.correctOptionIds.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["correctOptionIds"],
        message: "single-answer questions have at most 1 correct option",
      });
    }
  });
export type DraftQuestionPayload = z.infer<typeof draftQuestionPayloadSchema>;

export const draftMaterialPayloadSchema = z.object({
  kind: z.literal("material"),
  text: z.string(),
});

export const draftItemPayloadSchema = z.union([
  draftQuestionPayloadSchema,
  draftMaterialPayloadSchema,
]);
export type DraftItemPayload = z.infer<typeof draftItemPayloadSchema>;

/** Which source segments (by ordinal) an item came from. */
export const sourceRefsSchema = z.array(z.object({ ordinal: z.number().int().nonnegative() }));
export type SourceRefs = z.infer<typeof sourceRefsSchema>;

export const importWarningsSchema = z.array(importWarningSchema);

export const patchImportItemSchema = z
  .object({
    decision: z.enum(["pending", "accepted", "excluded"]),
    edit: z
      .object({
        type: z.enum(["mcq_single", "mcq_multi"]),
        prompt: z.string(),
        originalPrompt: z.string().max(10_000).nullable(),
        codeSnippet: z.string().nullable(),
        explanation: z.string().nullable(),
        options: z.array(optionSchema),
        correctOptionIds: z.array(z.string()),
      })
      .partial()
      .refine((edit) => Object.keys(edit).length > 0, "edit must change at least one field"),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "at least one field is required");
export type PatchImportItemInput = z.infer<typeof patchImportItemSchema>;

export const publishImportSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    questionSetId: z.uuid().optional(),
  })
  .refine((body) => Boolean(body.title) !== Boolean(body.questionSetId), {
    message: "provide either title (new set) or questionSetId (existing set)",
  });
export type PublishImportInput = z.infer<typeof publishImportSchema>;
