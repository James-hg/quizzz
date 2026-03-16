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

export interface ChatProvider {
    readonly name: string;
    generateReply(input: ChatGenerateInput): Promise<string>;
}
