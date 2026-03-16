import { FallbackProvider } from "./providers/fallbackProvider";
import { GeminiProvider } from "./providers/geminiProvider";
import { ChatProvider } from "./types";

export function createChatProvider(): ChatProvider {
    const preferred = (import.meta.env.VITE_AI_PROVIDER || "gemini").toLowerCase();
    const apiKey = (import.meta.env.VITE_GEMINI_API_KEY || "").trim();
    const model = (import.meta.env.VITE_GEMINI_MODEL || "gemini-2.0-flash").trim();

    if (preferred === "gemini" && apiKey) {
        return new GeminiProvider({ apiKey, model });
    }

    return new FallbackProvider();
}
