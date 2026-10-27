import { fileTypeFromBuffer } from "file-type";
import { IMAGE_MIME_TYPES, IMAGE_TYPE_LABEL, type ImageMime } from "@/lib/images";
import { ApiError } from "@/server/http/errors";

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export class UnsupportedImage extends ApiError {
  constructor() {
    super(415, "unsupported_image", `Only ${IMAGE_TYPE_LABEL} images are supported.`);
    this.name = "UnsupportedImage";
  }
}

export class ImageTooLarge extends ApiError {
  constructor(maxBytes: number) {
    super(
      413,
      "image_too_large",
      `This image is too large. The maximum size is ${formatBytes(maxBytes)}.`,
    );
    this.name = "ImageTooLarge";
  }
}

export type DetectedImage = { mime: ImageMime };

/**
 * Checks size first, then the file's real type from its bytes. The name and the type the client
 * claimed are ignored, and anything else (SVG, GIF, a renamed document) is refused.
 */
export async function detectImage(bytes: Uint8Array, maxBytes: number): Promise<DetectedImage> {
  if (bytes.length === 0) {
    throw new ApiError(422, "empty_image", "This image file is empty.");
  }
  if (bytes.length > maxBytes) throw new ImageTooLarge(maxBytes);
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !(IMAGE_MIME_TYPES as readonly string[]).includes(detected.mime)) {
    throw new UnsupportedImage();
  }
  return { mime: detected.mime as ImageMime };
}
