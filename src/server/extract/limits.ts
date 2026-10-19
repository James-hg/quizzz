import { fileTypeFromBuffer } from "file-type";
import { Corrupt, TooLarge, UnsupportedFormat } from "./errors";
import type { ExtractLimits, UploadedFile } from "./types";

export const DEFAULT_LIMITS: ExtractLimits = {
  maxUploadBytes: 10 * 1024 * 1024,
  maxZipEntries: 1000,
  maxZipTotalBytes: 100 * 1024 * 1024,
  maxZipEntryBytes: 20 * 1024 * 1024,
  timeoutMs: 30_000,
};

export function limitsFromEnv(env: { MAX_UPLOAD_BYTES: number }): ExtractLimits {
  return { ...DEFAULT_LIMITS, maxUploadBytes: env.MAX_UPLOAD_BYTES };
}

type Family = "zip" | "pdf" | "text";

const EXTENSION_FAMILY: Record<string, Family> = {
  docx: "zip",
  pptx: "zip",
  xlsx: "zip",
  pdf: "pdf",
  txt: "text",
  md: "text",
  csv: "text",
};

const OOXML_MIME_BY_EXTENSION: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    // A multi-byte character may be cut at the sample boundary; retry without the last bytes.
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, sample.length - 3));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Checks size and that the bytes match the claimed extension (magic bytes, not just the name).
 * Returns the file with the detected MIME type attached.
 */
export async function validateUpload(
  buffer: Buffer,
  file: UploadedFile,
  limits: ExtractLimits,
): Promise<UploadedFile & { detectedMime: string }> {
  if (buffer.length > limits.maxUploadBytes) throw new TooLarge(limits.maxUploadBytes);
  if (buffer.length === 0) throw new Corrupt("This file is empty.");

  const extension = extensionOf(file.filename);
  const family = EXTENSION_FAMILY[extension];
  if (!family) throw new UnsupportedFormat();

  const detected = await fileTypeFromBuffer(buffer);

  if (family === "text") {
    // Text has no magic bytes: reject anything recognisably binary or non-UTF-8.
    if (detected || !looksLikeText(buffer)) throw new UnsupportedFormat();
    return { ...file, detectedMime: "text/plain" };
  }

  if (family === "pdf") {
    if (detected?.mime !== "application/pdf") {
      throw detected ? new UnsupportedFormat() : new Corrupt();
    }
    return { ...file, detectedMime: detected.mime };
  }

  // OOXML (a ZIP container): the bytes must be a ZIP, and must not be a different OOXML type.
  if (!detected) throw new Corrupt();
  const isZip = detected.mime === "application/zip" || detected.mime.includes("openxmlformats");
  if (!isZip) throw new UnsupportedFormat();
  const expected = OOXML_MIME_BY_EXTENSION[extension];
  if (detected.mime.includes("openxmlformats") && detected.mime !== expected) {
    throw new UnsupportedFormat("The file contents do not match its extension.");
  }
  return { ...file, detectedMime: detected.mime };
}
