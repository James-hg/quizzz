/** JSON shapes the browser receives from the app's own API (dates arrive as strings). */

export type AnchorView = {
  type: string;
  index?: number;
  page?: number;
  slide?: number;
  line?: number;
};

export type WarningView = { code: string; message: string; anchor?: AnchorView };

export type ImportOption = { id: string; text: string };

export type ImportQuestionPayload = {
  kind: "question";
  type: "mcq_single" | "mcq_multi";
  prompt: string;
  codeSnippet?: string | null;
  explanation?: string | null;
  options: ImportOption[];
  correctOptionIds: string[];
};

export type ImportItemView = {
  id: string;
  position: number;
  kind: "question" | "material";
  payload: ImportQuestionPayload | { kind: "material"; text: string };
  warnings: WarningView[];
  decision: "pending" | "accepted" | "edited" | "excluded";
  sources: { ordinal: number; kind: string; text: string }[];
};

export type ImportView = {
  id: string;
  courseId: string;
  status: "extracted" | "reviewing" | "published" | "failed";
  errorMessage: string | null;
  warnings: WarningView[];
  publishedQuestionSetId: string | null;
  source: { filename: string; sizeBytes: number } | null;
  items: ImportItemView[];
};

export type SupportedFormat = { extension: string; label: string };

export function describeAnchor(anchor?: AnchorView): string {
  if (!anchor) return "";
  if (anchor.type === "docx_paragraph" && anchor.index !== undefined)
    return `paragraph ${anchor.index + 1}`;
  if (anchor.type === "pdf_page" && anchor.page) return `page ${anchor.page}`;
  if (anchor.type === "slide" && anchor.slide) return `slide ${anchor.slide}`;
  if (anchor.type === "line" && anchor.line) return `line ${anchor.line}`;
  return "";
}
