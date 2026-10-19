import type { ExtractResult } from "@/lib/schemas";

export type { Asset, Block, ExtractAnchor, ExtractResult, TextRun, Warning } from "@/lib/schemas";

export type ExtractLimits = {
  maxUploadBytes: number;
  maxZipEntries: number;
  maxZipTotalBytes: number;
  maxZipEntryBytes: number;
  timeoutMs: number;
};

/** What the pipeline knows about an upload before parsing it. */
export type UploadedFile = {
  filename: string;
  mimeType: string;
  /** Detected from magic bytes by validateUpload, not trusted from the client. */
  detectedMime?: string;
};

export type SupportedFormat = { extension: string; label: string };

export interface Extractor {
  readonly name: string;
  /** Formats shown to students, e.g. [{ extension: "docx", label: "Word (.docx)" }]. */
  readonly formats?: readonly SupportedFormat[];
  canHandle(file: UploadedFile): boolean;
  /** Must observe `signal` and stop work when it aborts. Never fetch external resources. */
  extract(buffer: Buffer, limits: ExtractLimits, signal: AbortSignal): Promise<ExtractResult>;
}
