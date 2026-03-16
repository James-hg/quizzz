import { ChatGenerateInput, ChatProvider, ChatRole } from "../types";

type GeminiPart = { text?: string };
type GeminiResponse = {
    candidates?: Array<{
        content?: {
            parts?: GeminiPart[];
        };
    }>;
};

type GeminiProviderOptions = {
    apiKey: string;
    model: string;
    systemInstruction?: string;
};

const GEMINI_URL_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export class GeminiProvider implements ChatProvider {
    readonly name = "gemini";
    private readonly apiKey: string;
    private readonly model: string;
    private readonly systemInstruction: string;

    constructor(options: GeminiProviderOptions) {
        this.apiKey = options.apiKey;
        this.model = options.model;
        this.systemInstruction =
            options.systemInstruction ||
            "You are Quizzz AI Study Coach. Be concise, practical, and helpful for quiz preparation.";
    }

    async generateReply(input: ChatGenerateInput): Promise<string> {
        const contents = toGeminiContents(input.messages, input.userMessage);
        const response = await fetch(
            `${GEMINI_URL_BASE}/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    system_instruction: {
                        parts: [{ text: this.systemInstruction }],
                    },
                    contents,
                    generationConfig: {
                        temperature: 0.6,
                        maxOutputTokens: 512,
                    },
                }),
            },
        );

        if (!response.ok) {
            const body = await response.text();
            throw new Error(
                `Gemini request failed (${response.status}). ${body || "No response body."}`,
            );
        }

        const data = (await response.json()) as GeminiResponse;
        const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join(" ").trim();
        if (!text) {
            throw new Error("Gemini returned an empty response.");
        }
        return text;
    }
}

function toGeminiContents(messages: ChatGenerateInput["messages"], userMessage: string) {
    const history = messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
            role: toGeminiRole(message.role),
            parts: [{ text: message.content }],
        }));

    history.push({
        role: "user",
        parts: [{ text: userMessage }],
    });

    return history;
}

function toGeminiRole(role: ChatRole): "user" | "model" {
    return role === "assistant" ? "model" : "user";
}
