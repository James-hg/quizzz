import { ChatGenerateInput, ChatProvider, StructuredGenerateInput } from "../types";

export class FallbackProvider implements ChatProvider {
    readonly name = "fallback";

    async generateReply(input: ChatGenerateInput): Promise<string> {
        const prompt = input.userMessage.trim();

        if (!prompt) {
            return "Ask me anything about quiz prep, revision strategy, or question design.";
        }

        return [
            "Gemini is not configured yet, so this is a local fallback response.",
            `You asked: \"${prompt}\"`,
            "Once VITE_GEMINI_API_KEY is set, this panel will call Gemini directly.",
        ].join(" ");
    }

    async generateStructured<T>(_input: StructuredGenerateInput): Promise<T> {
        throw new Error("Structured AI actions require Gemini to be configured.");
    }
}
