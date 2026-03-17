export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
    id: string;
    role: ChatRole;
    content: string;
    createdAt: number;
};

export type ChatGenerateInput = {
    messages: ChatMessage[];
    userMessage: string;
};

export type StructuredGenerateInput = {
    prompt: string;
    systemInstruction?: string;
    maxOutputTokens?: number;
    temperature?: number;
};

export interface ChatProvider {
    readonly name: string;
    generateReply(input: ChatGenerateInput): Promise<string>;
    generateStructured<T>(input: StructuredGenerateInput): Promise<T>;
}
