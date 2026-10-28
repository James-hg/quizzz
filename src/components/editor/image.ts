import { IMAGE_ALT_MAX, IMAGE_MIME_TYPES, IMAGE_TYPE_LABEL } from "@/lib/images";

/** What the image field holds: the saved image, a newly chosen file, or nothing. */
export type ImageValue =
  | null
  | { kind: "existing"; id: string; url: string; alt: string }
  | { kind: "new"; file: File; previewUrl: string; alt: string };

export type ExistingImage = { id: string; url: string; alt: string };

/** What to tell the server when the question is saved. */
export type ImageChange =
  | { type: "keep" }
  | { type: "remove" }
  | { type: "alt"; imageId: string; alt: string }
  | { type: "upload"; file: File; alt: string };

export function initialImageValue(image: ExistingImage | null | undefined): ImageValue {
  return image ? { kind: "existing", ...image } : null;
}

/** Works out the smallest change that turns the saved image into the chosen one. */
export function imageChangeOf(
  saved: ExistingImage | null | undefined,
  value: ImageValue,
): ImageChange {
  if (!value) return saved ? { type: "remove" } : { type: "keep" };
  if (value.kind === "new") return { type: "upload", file: value.file, alt: value.alt.trim() };
  if (saved && saved.id === value.id && saved.alt === value.alt.trim()) return { type: "keep" };
  return { type: "alt", imageId: value.id, alt: value.alt.trim() };
}

/** The image field's problems, or null. Checked before saving, and the server checks again. */
export function imageProblem(value: ImageValue): string | null {
  if (!value) return null;
  const alt = value.alt.trim();
  if (!alt) return "Describe the image for people who cannot see it.";
  if (alt.length > IMAGE_ALT_MAX) return `Keep the description under ${IMAGE_ALT_MAX} characters.`;
  return null;
}

/** Quick check of a chosen file so the person is told at once, not after an upload. */
export function fileProblem(file: File, maxBytes: number): string | null {
  if (!(IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return `Only ${IMAGE_TYPE_LABEL} images are supported.`;
  }
  if (file.size > maxBytes) {
    const mb = maxBytes / (1024 * 1024);
    const limit =
      mb >= 1
        ? `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
        : `${Math.round(maxBytes / 1024)} KB`;
    return `This image is too large. The maximum size is ${limit}.`;
  }
  return null;
}
