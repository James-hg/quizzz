import { z } from "zod";
import { courseLanguageSchema } from "./content";
import { questionContentSchema, type QuestionContent } from "./question-input";

/** Bumped only for breaking changes to the fixture format. */
export const SAMPLE_FORMAT_VERSION = 1;

const id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, "ids use letters, digits, '-' and '_' (max 64 chars)");

function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** Who checked an item and when. Only items with provenance are loaded as human reviewed. */
export const provenanceSchema = z
  .object({
    checkedBy: z.string().trim().min(1, "checkedBy cannot be empty").max(120),
    checkedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "use the format YYYY-MM-DD")
      .refine(isRealDate, "not a real calendar date")
      .refine(
        (value) => new Date(`${value}T00:00:00Z`).getTime() <= Date.now() + 24 * 60 * 60 * 1000,
        "checkedAt cannot be in the future",
      ),
    notes: z.string().max(1000).optional(),
  })
  .strict();
export type Provenance = z.infer<typeof provenanceSchema>;

export const sampleSectionSchema = z
  .object({
    id,
    title: z.string().trim().min(1).max(200),
    text: z.string().trim().min(1, "section text cannot be empty").max(20_000),
    provenance: provenanceSchema.optional(),
  })
  .strict();
export type SampleSection = z.infer<typeof sampleSectionSchema>;

const questionMetaSchema = z.object({
  id,
  sections: z.array(id).default([]),
  provenance: provenanceSchema.optional(),
});

export type SampleQuestion = {
  id: string;
  /** Ids of the source sections this question is based on. */
  sections: string[];
  provenance?: Provenance;
  content: QuestionContent;
};

const CONTENT_KEYS = {
  mcq_single: ["type", "prompt", "codeSnippet", "explanation", "options", "correctOptionIds"],
  mcq_multi: ["type", "prompt", "codeSnippet", "explanation", "options", "correctOptionIds"],
  short_answer: ["type", "prompt", "codeSnippet", "explanation", "accepted", "caseSensitive"],
  output_prediction: ["type", "prompt", "codeSnippet", "explanation", "accepted", "caseSensitive"],
  fill_blank: ["type", "prompt", "codeSnippet", "explanation", "blanks", "caseSensitive"],
} as const;

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

function unknownFieldMessage(key: string, type: string, allowed: readonly string[]): string {
  const close = allowed.find((k) => editDistance(k.toLowerCase(), key.toLowerCase()) <= 2);
  return `unknown field "${key}" for a ${type} question${close ? ` (did you mean "${close}"?)` : ""}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A question is its meta fields (id, sections, provenance) plus the same content fields the
 * question editor accepts. Unknown fields are errors, so a typo like `correctOptionId` is caught.
 */
export const sampleQuestionSchema = z.unknown().transform((raw, ctx): SampleQuestion => {
  if (!isRecord(raw)) {
    ctx.addIssue({ code: "custom", message: "a question must be a mapping" });
    return z.NEVER;
  }
  const { id: qid, sections, provenance, ...rest } = raw;
  const meta = questionMetaSchema.safeParse({ id: qid, sections, provenance });
  const content = questionContentSchema.safeParse(rest);

  for (const issue of meta.success ? [] : meta.error.issues) {
    ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  }
  for (const issue of content.success ? [] : content.error.issues) {
    ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  }
  // Unknown fields are reported even when the content is otherwise invalid, so a misspelled
  // required field shows both the typo and the missing field.
  const type = typeof rest.type === "string" ? rest.type : undefined;
  const allowed =
    type && type in CONTENT_KEYS ? CONTENT_KEYS[type as keyof typeof CONTENT_KEYS] : undefined;
  if (type && allowed) {
    for (const key of Object.keys(rest)) {
      if (!(allowed as readonly string[]).includes(key)) {
        ctx.addIssue({
          code: "custom",
          message: unknownFieldMessage(key, type, allowed),
          path: [key],
        });
      }
    }
  }
  if (!meta.success || !content.success) return z.NEVER;
  return {
    id: meta.data.id,
    sections: meta.data.sections,
    provenance: meta.data.provenance,
    content: content.data,
  };
});

export type CrossIssue = { path: (string | number)[]; message: string };

/** Duplicate ids and dangling section references. Works on any shape that has the ids. */
export function crossCheck(value: {
  sections: { id: string }[];
  questions: { id: string; sections: string[] }[];
}): CrossIssue[] {
  const issues: CrossIssue[] = [];
  const sectionIds = new Set<string>();
  value.sections.forEach((section, index) => {
    if (sectionIds.has(section.id)) {
      issues.push({
        path: ["sections", index, "id"],
        message: `duplicate section id "${section.id}"`,
      });
    }
    sectionIds.add(section.id);
  });
  const questionIds = new Set<string>();
  value.questions.forEach((question, index) => {
    if (questionIds.has(question.id)) {
      issues.push({
        path: ["questions", index, "id"],
        message: `duplicate question id "${question.id}"`,
      });
    }
    questionIds.add(question.id);
    question.sections.forEach((ref, refIndex) => {
      if (!sectionIds.has(ref)) {
        issues.push({
          path: ["questions", index, "sections", refIndex],
          message: `unknown section "${ref}"`,
        });
      }
    });
  });
  return issues;
}

/** Same checks on unvalidated data, so they are reported alongside structural errors. */
export function crossCheckRaw(raw: unknown): CrossIssue[] {
  if (!isRecord(raw)) return [];
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const str = (value: unknown) => (typeof value === "string" ? value : undefined);
  const sections = list(raw.sections).map((s) => ({ id: str(isRecord(s) ? s.id : undefined) }));
  const questions = list(raw.questions).map((q) => ({
    id: str(isRecord(q) ? q.id : undefined),
    sections: list(isRecord(q) ? q.sections : undefined).map(str),
  }));
  // Entries without a usable id/ref are already reported by the structural schema.
  return crossCheck({
    sections: sections.map((s, i) => ({ id: s.id ?? `\u0000missing-${i}` })),
    questions: questions.map((q, i) => ({
      id: q.id ?? `\u0000missing-${i}`,
      sections: q.sections.filter((r): r is string => r !== undefined),
    })),
  });
}

export const sampleCourseSchema = z
  .object({
    format: z.literal(SAMPLE_FORMAT_VERSION, `format must be ${SAMPLE_FORMAT_VERSION}`),
    course: z
      .object({
        title: z.string().trim().min(1).max(120),
        subject: z.string().trim().min(1).max(200),
        language: courseLanguageSchema,
      })
      .strict(),
    sections: z.array(sampleSectionSchema).default([]),
    questions: z.array(sampleQuestionSchema).min(1, "add at least one question"),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const issue of crossCheck(value)) {
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }
  });

export type SampleCourse = z.infer<typeof sampleCourseSchema>;
