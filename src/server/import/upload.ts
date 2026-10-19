import "server-only";
import { TooLarge } from "@/server/extract/errors";
import { badRequest } from "@/server/http/errors";

// Multipart framing (boundaries, headers, other fields) on top of the file itself.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export type ReceivedUpload = { filename: string; mimeType: string; bytes: Buffer };

/** For display only: the name never reaches the filesystem. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "upload").slice(0, 255);
}

/**
 * Reads a multipart upload with a hard byte cap. The body is counted as it streams, so an
 * oversized request is cancelled instead of being buffered whole.
 */
export async function readUpload(request: Request, maxFileBytes: number): Promise<ReceivedUpload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw badRequest("Send the file as multipart/form-data with a 'file' field");
  }
  const cap = maxFileBytes + MULTIPART_OVERHEAD_BYTES;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) throw new TooLarge(maxFileBytes);
  if (!request.body) throw badRequest("Request body is empty");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw new TooLarge(maxFileBytes);
    }
    chunks.push(value);
  }

  let form: FormData;
  try {
    form = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: Buffer.concat(chunks),
    }).formData();
  } catch {
    throw badRequest("Could not read the upload");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("Choose a file to upload (field name: file)");
  if (file.size > maxFileBytes) throw new TooLarge(maxFileBytes);
  return {
    filename: sanitizeFilename(file.name),
    mimeType: file.type,
    bytes: Buffer.from(await file.arrayBuffer()),
  };
}
