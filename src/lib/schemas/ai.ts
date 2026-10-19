import { z } from "zod";
import { questionContentSchema } from "./question-input";

const text = (max: number) => z.string().trim().min(1).max(max);

export const chatRequestSchema = z.object({
  message: text(2000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: text(2000) }))
    .max(10)
    .default([]),
  courseId: z.uuid().optional(),
  questionSetId: z.uuid().optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const generateQuestionsRequestSchema = z.object({
  count: z.number().int().min(1).max(10).default(5),
  topic: text(200).optional(),
});
export type GenerateQuestionsRequest = z.infer<typeof generateQuestionsRequestSchema>;

/** What the model is asked to return. It is a proposal and is validated again before saving. */
export const generatedQuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        prompt: text(2000),
        options: z.array(text(500)).length(4),
        correctIndex: z.number().int().min(0).max(3),
        explanation: text(1000).optional(),
      }),
    )
    .min(1)
    .max(10),
});
export type GeneratedQuestions = z.infer<typeof generatedQuestionsSchema>;

export const suggestedTitleSchema = z.object({ title: text(120) });

export const saveProposalsSchema = z.object({
  proposals: z.array(questionContentSchema).min(1).max(20),
});
export type SaveProposalsInput = z.infer<typeof saveProposalsSchema>;
