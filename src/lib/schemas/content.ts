import { z } from "zod";

export const courseLanguageSchema = z.enum(["python", "java", "c", "cpp", "javascript"]);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export const createCourseSchema = z.object({
  title: z.string().trim().min(1).max(120),
  subject: z.string().trim().min(1).max(120),
  language: courseLanguageSchema.nullish(),
  examDate: isoDate.nullish(),
});

export const updateCourseSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    subject: z.string().trim().min(1).max(120),
    language: courseLanguageSchema.nullable(),
    examDate: isoDate.nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "at least one field is required");

export const createQuestionSetSchema = z.object({ title: z.string().trim().min(1).max(120) });
export const renameQuestionSetSchema = createQuestionSetSchema;

/** Question ids in their new order; must be exactly the set's current questions. */
export const reorderSchema = z.object({ questionIds: z.array(z.uuid()).min(1) });
