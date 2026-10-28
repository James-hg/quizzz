import type { ExtractAnchor, ExtractResult, Warning } from "@/lib/schemas";

/**
 * What a format-specific detector returns for one question it found. A detector never guesses
 * answers: `isCorrect` is true only for options the document explicitly marks.
 */
export type DetectedQuestion = {
  prompt: string;
  /** The prompt as written, when the detector already removed a leading question number. */
  originalPrompt?: string;
  options: { text: string; isCorrect: boolean }[];
  anchor: ExtractAnchor;
  /** The first usable image (an extractor asset id) found with this question. */
  imageAssetId?: string;
  /** Images beyond the first, which are not imported. */
  extraImages?: number;
  /** The stored image, once it has been read from the document and saved. */
  image?: { imageId: string; alt: string };
  /** Ids of the extractor blocks that make up the question (stem and options). */
  blockIds?: string[];
  warnings: Warning[];
};

export type Detection = {
  questions: DetectedQuestion[];
  /** Problems not tied to one question (e.g. an option before any question). */
  warnings: Warning[];
};

export type Detector = (result: ExtractResult) => Detection;
