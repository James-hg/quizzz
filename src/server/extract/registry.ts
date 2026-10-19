import "server-only";
import type { ExtractResult } from "@/lib/schemas";
import { extractResultSchema } from "@/lib/schemas";
import { Corrupt, ExtractError, UnsupportedFormat } from "./errors";
import { validateUpload } from "./limits";
import { withTimeout } from "./timeout";
import type { ExtractLimits, Extractor, SupportedFormat, UploadedFile } from "./types";

const extractors: Extractor[] = [];

/** Later formats (DOCX in A7, PDF/PPTX/CSV/XLSX/TXT in Phase C) register themselves here. */
export function registerExtractor(extractor: Extractor): void {
  if (extractors.some((e) => e.name === extractor.name)) {
    throw new Error(`Extractor "${extractor.name}" is already registered`);
  }
  extractors.push(extractor);
}

/** Formats of every registered extractor, for accurate upload messaging. */
export function supportedFormats(): SupportedFormat[] {
  return extractors.flatMap((e) => [...(e.formats ?? [])]);
}

export function findExtractor(file: UploadedFile): Extractor | undefined {
  return extractors.find((e) => e.canHandle(file));
}

/** Test helper: remove all registrations. */
export function clearExtractors(): void {
  extractors.length = 0;
}

/**
 * Validates the upload, picks an extractor, and runs it under the time limit.
 * The extractor's output is checked against the shared schema before it is returned.
 */
export async function runExtraction(
  buffer: Buffer,
  file: UploadedFile,
  limits: ExtractLimits,
  signal?: AbortSignal,
): Promise<ExtractResult> {
  const validated = await validateUpload(buffer, file, limits);
  const extractor = findExtractor(validated);
  if (!extractor) throw new UnsupportedFormat();

  try {
    const result = await withTimeout(
      (inner) => extractor.extract(buffer, limits, inner),
      limits.timeoutMs,
      signal,
    );
    return extractResultSchema.parse(result);
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    // Parser bugs and malformed content surface as a user-readable error, never a stack trace.
    console.error(`Extractor "${extractor.name}" failed`, error);
    throw new Corrupt();
  }
}
