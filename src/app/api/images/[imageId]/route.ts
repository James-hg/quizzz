import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { handleRoute, notFound } from "@/server/http/errors";
import { parseId } from "@/server/http/request";
import { deleteOwnedImage, getOwnedImage } from "@/server/images/service";
import { getStorage } from "@/server/storage";
import { StorageNotFoundError } from "@/server/storage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ imageId: string }> };

/**
 * The only way to read an image: signed in, and the image must belong to you. Anyone else gets
 * the same 404 as for a missing image. The content type comes from the bytes detected at upload,
 * and the response cannot be framed or scripted.
 */
export const GET = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const imageId = parseId((await params).imageId, "Image");
  const image = await getOwnedImage(getDb(), user.id, imageId);

  const etag = `"${image.sha256}"`;
  const headers = new Headers({
    ETag: etag,
    // Private and revalidated every time, so a signed-out or different user never gets a copy.
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  let bytes: Buffer;
  try {
    bytes = await getStorage().get(image.storageKey);
  } catch (error) {
    if (error instanceof StorageNotFoundError) throw notFound("Image not found");
    throw error;
  }
  headers.set("Content-Type", image.mimeType);
  headers.set("Content-Length", String(bytes.length));
  return new Response(new Uint8Array(bytes), { status: 200, headers });
});

/**
 * Discards one of your own images that nothing uses (for example after a failed save). An image
 * a question or an import still shows cannot be deleted (409 image_in_use).
 */
export const DELETE = handleRoute(async (request: Request, { params }: Ctx) => {
  const user = await requireUser(request);
  const imageId = parseId((await params).imageId, "Image");
  await deleteOwnedImage(getDb(), getStorage(), user.id, imageId);
  return new Response(null, { status: 204 });
});
