import type { ExtractAnchor, ExtractResult, Warning } from "@/lib/schemas";

/**
 * What a format-specific detector returns for one question it found. A detector never guesses
 * answers: `isCorrect` is true only for options the document explicitly marks.
 */
export type DetectedQuestion = {
  prompt: string;
  options: { text: string; isCorrect: boolean }[];
  anchor: ExtractAnchor;
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
