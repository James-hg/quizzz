import "server-only";
import { docxExtractor } from "./docx";
import { findExtractor, registerExtractor } from "./registry";

/** Registers the built-in extractors. Safe to call more than once. */
export function registerDefaultExtractors(): void {
  const probe = { filename: "x.docx", mimeType: "" };
  if (!findExtractor(probe)) registerExtractor(docxExtractor);
}
