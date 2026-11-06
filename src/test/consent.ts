import { AI_NOTICE } from "@/lib/ai-consent";

/** A `GET /api/ai/consent` body for component tests. */
export function consentStatus(accepted: boolean, noticeVersion = "v1") {
  return { noticeVersion, accepted, notice: AI_NOTICE };
}
