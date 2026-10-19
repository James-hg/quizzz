import { z } from "zod";

export const extractAnchorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("docx_paragraph"),
    index: z.number().int().nonnegative(),
    headingPath: z.array(z.string()).default([]),
  }),
  z.object({ type: z.literal("pdf_page"), page: z.number().int().positive() }),
  z.object({ type: z.literal("slide"), slide: z.number().int().positive() }),
  z.object({ type: z.literal("line"), line: z.number().int().positive() }),
  z.object({
    type: z.literal("row"),
    sheet: z.string().nullable(),
    row: z.number().int().positive(),
  }),
]);

export const textRunSchema = z.object({
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  code: z.boolean().optional(),
});

export const blockKindSchema = z.enum([
  "heading",
  "paragraph",
  "list_item",
  "table",
  "slide",
  "page",
]);

export const blockSchema = z.object({
  id: z.string().min(1),
  kind: blockKindSchema,
  text: z.string(),
  runs: z.array(textRunSchema).optional(),
  listLevel: z.number().int().nonnegative().optional(),
  anchor: extractAnchorSchema,
});

export const assetSchema = z.object({
  id: z.string().min(1),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  anchor: extractAnchorSchema.optional(),
});

export const warningSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  anchor: extractAnchorSchema.optional(),
});

export const extractMetaSchema = z.object({
  format: z.string(),
  title: z.string().optional(),
  pageCount: z.number().int().nonnegative().optional(),
});

export const extractResultSchema = z.object({
  blocks: z.array(blockSchema),
  assets: z.array(assetSchema),
  warnings: z.array(warningSchema),
  meta: extractMetaSchema,
});

export type ExtractAnchor = z.infer<typeof extractAnchorSchema>;
export type TextRun = z.infer<typeof textRunSchema>;
export type Block = z.infer<typeof blockSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type Warning = z.infer<typeof warningSchema>;
export type ExtractResult = z.infer<typeof extractResultSchema>;
