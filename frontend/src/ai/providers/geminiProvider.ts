import {
    ChatGenerateInput,
    ChatProvider,
    ChatRole,
    StructuredGenerateInput,
} from "../types";

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
        return this.requestText({
            systemInstruction: this.systemInstruction,
            contents,
            temperature: 0.6,
            maxOutputTokens: 512,
        });
    }

    async generateStructured<T>(input: StructuredGenerateInput): Promise<T> {
        const text = await this.requestText({
            systemInstruction: [
                this.systemInstruction,
                input.systemInstruction,
                "Return valid JSON only. Do not wrap it in markdown fences.",
            ]
                .filter(Boolean)
                .join("\n\n"),
            contents: [
                {
                    role: "user",
                    parts: [{ text: input.prompt }],
                },
            ],
            temperature: input.temperature ?? 0.2,
            maxOutputTokens: input.maxOutputTokens ?? 768,
        });

        try {
            return JSON.parse(extractJson(text)) as T;
        } catch (error) {
            throw new Error(
                `Gemini returned invalid JSON: ${
                    error instanceof Error ? error.message : "Unknown parse error."
                }`,
            );
        }
    }

    private async requestText(input: {
        systemInstruction: string;
        contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }>;
        temperature: number;
        maxOutputTokens: number;
    }) {
        const response = await fetch(
            `${GEMINI_URL_BASE}/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    system_instruction: {
                        parts: [{ text: input.systemInstruction }],
                    },
                    contents: input.contents,
                    generationConfig: {
                        temperature: input.temperature,
                        maxOutputTokens: input.maxOutputTokens,
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
        const text = data.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || "")
            .join(" ")
            .trim();
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

function extractJson(input: string) {
    const fencedMatch = input.match(/```json\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
        return fencedMatch[1].trim();
    }

    const genericFenceMatch = input.match(/```\s*([\s\S]*?)```/);
    if (genericFenceMatch?.[1]) {
        return genericFenceMatch[1].trim();
    }

    return input.trim();
}
