import { z } from "zod";

/**
 * Version of the AI data notice. Change it whenever the wording below changes in substance: every
 * user is then asked to accept again before their next AI request.
 */
export const AI_NOTICE_VERSION = "2026-11-06-v1";

export const GEMINI_TERMS_URL = "https://ai.google.dev/gemini-api/terms";

export const AI_NOTICE = {
  title: "Before you use AI help",
  paragraphs: [
    "AI help runs on Google Gemini, a hosted service. It does not run on this computer. When you use it, the text of your request is sent to Google, together with the parts of your question set or course the request needs, such as question text and answer options.",
    "On the unpaid Gemini API tier, Google says the content you submit and the responses it generates can be used to improve its products, and can be read by people. Do not send sensitive, confidential or personal information.",
    "AI answers are proposals and can be wrong. You decide what to keep.",
    "You can say no and keep studying: practice, importing and editing all work without AI.",
  ],
  termsUrl: GEMINI_TERMS_URL,
  termsLabel: "Google Gemini API terms",
} as const;

export const acceptConsentSchema = z.strictObject({
  noticeVersion: z.string().min(1).max(64),
  accepted: z.literal(true),
});

export type AiConsentStatus = {
  noticeVersion: string;
  accepted: boolean;
  notice: { title: string; paragraphs: readonly string[]; termsUrl: string; termsLabel: string };
};
