import "server-only";
import type { Detector } from "./types";

const detectors = new Map<string, Detector>();

/** Keyed by extractor name. A7 registers the DOCX multiple-choice detector here. */
export function registerDetector(extractorName: string, detector: Detector): void {
  detectors.set(extractorName, detector);
}

export function detectorFor(extractorName: string): Detector | undefined {
  return detectors.get(extractorName);
}

/** Test helper. */
export function clearDetectors(): void {
  detectors.clear();
}
