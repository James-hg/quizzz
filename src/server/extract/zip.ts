import { Unzip, UnzipInflate, unzipSync } from "fflate";
import { Corrupt, ZipBomb } from "./errors";
import type { ExtractLimits } from "./types";

export type ZipEntryInfo = { name: string; compressedSize: number; declaredSize: number };

/** Rejects names that could escape an extraction root or confuse path handling. */
export function isUnsafeEntryName(name: string): boolean {
  if (name.length === 0 || name.includes("\0") || name.includes("\\")) return true;
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return true;
  return name.split("/").some((segment) => segment === "..");
}

/**
 * Lists entries from the central directory without inflating anything, then enforces entry
 * count, per-entry and total declared size, and path safety.
 */
export function inspectZip(buffer: Uint8Array, limits: ExtractLimits): ZipEntryInfo[] {
  const entries: ZipEntryInfo[] = [];
  try {
    unzipSync(buffer, {
      filter(file) {
        entries.push({
          name: file.name,
          compressedSize: file.size,
          declaredSize: file.originalSize,
        });
        if (entries.length > limits.maxZipEntries)
          throw new ZipBomb("This file has too many parts.");
        return false; // never inflate during inspection
      },
    });
  } catch (error) {
    if (error instanceof ZipBomb) throw error;
    throw new Corrupt();
  }

  let total = 0;
  for (const entry of entries) {
    if (isUnsafeEntryName(entry.name)) throw new ZipBomb("This file contains an unsafe path.");
    if (entry.declaredSize > limits.maxZipEntryBytes) throw new ZipBomb();
    total += entry.declaredSize;
    if (total > limits.maxZipTotalBytes) throw new ZipBomb();
  }
  return entries;
}

/**
 * Inflates only the selected entries and counts the bytes actually produced, so a ZIP that
 * lies about its sizes is stopped as soon as it exceeds the limits.
 */
export function readZipEntries(
  buffer: Uint8Array,
  limits: ExtractLimits,
  select: (name: string) => boolean,
): Map<string, Uint8Array> {
  const entries = inspectZip(buffer, limits);
  const wanted = new Set(entries.map((e) => e.name).filter(select));
  const result = new Map<string, Uint8Array>();
  let total = 0;
  let failure: Error | undefined;

  const unzip = new Unzip((file) => {
    if (!wanted.has(file.name) || failure) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) {
        failure = new Corrupt();
        return;
      }
      size += chunk.length;
      total += chunk.length;
      if (size > limits.maxZipEntryBytes || total > limits.maxZipTotalBytes) {
        failure = new ZipBomb();
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) {
        const out = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) {
          out.set(part, offset);
          offset += part.length;
        }
        result.set(file.name, out);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  try {
    unzip.push(buffer, true);
  } catch {
    throw failure ?? new Corrupt();
  }
  if (failure) throw failure;
  return result;
}
