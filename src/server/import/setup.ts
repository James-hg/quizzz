import "server-only";
import { registerDefaultExtractors } from "@/server/extract/defaults";
import { registerDetector } from "./detectors";
import { detectDocxQuestions } from "./docx-detector";

/** Registers the built-in extractors and their question detectors. Safe to call repeatedly. */
export function ensureImportersRegistered(): void {
  registerDefaultExtractors();
  registerDetector("docx", detectDocxQuestions);
}
