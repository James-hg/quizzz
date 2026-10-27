import { z } from "zod";

/** Types a question image may have. Detected from the file's bytes, never from its name. */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

export const IMAGE_TYPE_LABEL = "PNG, JPEG or WebP";
export const IMAGE_ALT_MAX = 300;

/** Alt text is required whenever an image is attached, so it is never left empty. */
export const imageAltSchema = z
  .string()
  .trim()
  .min(1, "Describe the image for people who cannot see it.")
  .max(IMAGE_ALT_MAX, `Keep the description under ${IMAGE_ALT_MAX} characters.`);

/** An image attached to a question revision: which stored image, and its description. */
export const questionImageInputSchema = z.object({
  imageId: z.uuid(),
  alt: imageAltSchema,
});
export type QuestionImageInput = z.infer<typeof questionImageInputSchema>;

/** What a client sees of an attached image. The URL needs a signed-in session that owns it. */
export type QuestionImageView = { id: string; url: string; alt: string };

export function imageUrl(imageId: string): string {
  return `/api/images/${imageId}`;
}
